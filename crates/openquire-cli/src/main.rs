use clap::{Args, Parser, Subcommand};
use openquire_core::{
    parse_workflow, resolve_pattern, PdfDocument, StampPosition, StampSpec, WorkflowStep,
};
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use walkdir::WalkDir;

const VERSION: &str = "1.0.0";

#[derive(Parser)]
#[command(
    name = "openquire",
    version = VERSION,
    about = "PDF tools from OpenQuire",
    help_template = "openquire {version}: PDF tools from OpenQuire\n\nUsage: openquire <command> <files or folders...> [options]\n\n{all-args}"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(short = 'o', long = "out", global = true, help = "Output folder (or file, for one input or merge)")]
    out: Option<PathBuf>,

    #[arg(short = 'r', long = "recursive", global = true, help = "Include PDFs in subfolders")]
    recursive: bool,

    #[arg(short = 'q', long = "quiet", global = true, help = "Only print errors")]
    quiet: bool,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "Show pages and properties; unsupported checks are reported as unknown")]
    Info(PathArgs),

    #[command(about = "Find and permanently remove text")]
    Redact(RedactArgs),

    #[command(about = "Add text to pages: page numbers, Bates numbers, watermarks")]
    Stamp(StampArgs),

    #[command(about = "Sign with a digital ID")]
    Sign(SignArgs),

    #[command(about = "Run metadata-only workflows (setMeta); other steps unavailable in the native CLI")]
    Run(RunArgs),

    #[command(about = "Combine files into one: openquire merge a.pdf b.pdf -o all.pdf")]
    Merge(MergeArgs),

    #[command(about = "Compression (unavailable in the native CLI)")]
    Compress(CompressArgs),

    #[command(about = "PDF/A conversion (unavailable in the native CLI)")]
    Pdfa(PdfaArgs),

    #[command(about = "Accessibility tagging (unavailable in the native CLI)")]
    Tag(TagArgs),

    #[command(about = "OCR (unavailable in the native CLI)")]
    Ocr(OcrArgs),

    #[command(about = "Export extracted text: --to txt|html (Office formats unavailable)")]
    Export(ExportArgs),
}

#[derive(Args)]
struct PathArgs {
    #[arg(required = true, help = "Files or folders to process")]
    paths: Vec<PathBuf>,
}

#[derive(Args)]
struct RedactArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "pattern", help = "email, phone, card, date, url, or a regular expression (repeatable)")]
    pattern: Vec<String>,

    #[arg(long = "term", help = "exact text to remove (repeatable)")]
    term: Vec<String>,
}

#[derive(Args)]
struct StampArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "text", help = "may use {page}, {pages}, {date}, {name}, {bates}")]
    text: Option<String>,

    #[arg(long = "position", default_value = "bc", help = "tl, tc, tr, bl, bc, br or center")]
    position: String,

    #[arg(long = "size", default_value = "10", help = "font size")]
    size: String,

    #[arg(long = "bates-start", default_value = "1", help = "first Bates number; continues across files")]
    bates_start: u64,
}

#[derive(Args)]
struct SignArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "p12", help = "certificate and key (.p12 or .pfx)")]
    p12: Option<PathBuf>,

    #[arg(long = "password", env = "OPENQUIRE_P12_PASSWORD", help = "or set OPENQUIRE_P12_PASSWORD")]
    password: Option<String>,

    #[arg(long = "reason")]
    reason: Option<String>,

    #[arg(long = "location")]
    location: Option<String>,

    #[arg(long = "timestamp")]
    timestamp: Option<String>,
}

#[derive(Args)]
struct RunArgs {
    #[arg(help = "Workflow JSON file")]
    workflow_file: PathBuf,

    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,
}

#[derive(Args)]
struct MergeArgs {
    #[arg(required = true, help = "Files to merge")]
    paths: Vec<PathBuf>,
}

#[derive(Args)]
struct CompressArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "level", default_value = "medium", help = "standard|medium|strong")]
    level: String,
}

#[derive(Args)]
struct PdfaArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "part", default_value = "2", help = "2|3")]
    part: u32,
}

#[derive(Args)]
struct TagArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "lang", default_value = "en-US")]
    lang: String,
}

#[derive(Args)]
struct OcrArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "lang", default_value = "eng")]
    lang: String,
}

#[derive(Args)]
struct ExportArgs {
    #[arg(help = "Files or folders to process")]
    paths: Vec<PathBuf>,

    #[arg(long = "to", help = "txt|html; docx and xlsx are unavailable in the native CLI")]
    to: Option<String>,
}

fn collect_pdf_files(paths: &[PathBuf], recursive: bool) -> Result<Vec<PathBuf>, (String, u8)> {
    let mut files = Vec::new();
    for p in paths {
        if !p.exists() {
            return Err((format!("No such file or folder: {}", p.display()), 2));
        }
        if p.is_dir() {
            let walker = if recursive {
                WalkDir::new(p)
            } else {
                WalkDir::new(p).max_depth(1)
            };
            for entry in walker.into_iter().filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        if ext.eq_ignore_ascii_case("pdf") {
                            files.push(path.to_path_buf());
                        }
                    }
                }
            }
        } else {
            files.push(p.clone());
        }
    }
    files.sort();
    if files.is_empty() {
        return Err(("No PDF files given.".to_string(), 2));
    }
    Ok(files)
}

fn output_path(input: &Path, suffix: &str, out: Option<&Path>, many: bool, ext: &str) -> PathBuf {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("document");
    let filename = if out.is_some() {
        format!("{stem}.{ext}")
    } else {
        format!("{stem}-{suffix}.{ext}")
    };

    match out {
        None => input.parent().unwrap_or(Path::new("")).join(filename),
        Some(o) => {
            if !many && o.extension().is_some() {
                if let Some(parent) = o.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                o.to_path_buf()
            } else {
                let _ = fs::create_dir_all(o);
                o.join(filename)
            }
        }
    }
}

fn unavailable(operation: &str) -> ExitCode {
    eprintln!("{operation} is not supported by the native CLI. No files were written. See the Node CLI or desktop app for these capabilities.");
    ExitCode::from(2)
}

fn text_html(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Extracted PDF text</title></head><body><pre>{escaped}</pre></body></html>\n"
    )
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().collect();
    // Intercept custom commands or unknown commands before clap for exit code 2 contract
    if raw_args.len() > 1 && !raw_args[1].starts_with('-') {
        let valid_cmds = ["info", "redact", "stamp", "sign", "run", "merge", "compress", "pdfa", "tag", "ocr", "export", "help"];
        if !valid_cmds.contains(&raw_args[1].as_str()) {
            eprintln!("Unknown command \"{}\". Run openquire --help to see the commands.", raw_args[1]);
            return ExitCode::from(2);
        }
    }

    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            // Check if user requested help
            if e.use_stderr() {
                eprintln!("{}", e);
                return ExitCode::from(2);
            } else {
                println!("{}", e);
                return ExitCode::from(0);
            }
        }
    };

    let command = match cli.command {
        Some(cmd) => cmd,
        None => {
            println!("openquire {}: PDF tools from OpenQuire\n\nUsage: openquire <command> <files or folders...> [options]", VERSION);
            return ExitCode::from(0);
        }
    };

    let quiet = cli.quiet;
    let say = |msg: &str| {
        if !quiet {
            println!("{msg}");
        }
    };

    let mut failed = 0;

    match command {
        Commands::Info(args) => {
            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };
            for file in files {
                match fs::read(&file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(pdf) => {
                            let info = pdf.info();
                            println!("{}", file.display());
                            println!(
                                "  pages: {}{}",
                                info.pages,
                                if info.encrypted { ", password protected" } else { "" }
                            );
                            if let Some(t) = &info.metadata.title {
                                println!("  title: {t}");
                            }
                            if let Some(a) = &info.metadata.author {
                                println!("  author: {a}");
                            }
                            if let Some(s) = &info.metadata.subject {
                                println!("  subject: {s}");
                            }
                            if let Some(k) = &info.metadata.keywords {
                                println!("  keywords: {k}");
                            }
                            println!("  signatures: unknown (not inspected by the native CLI)");
                            println!("  tagged: unknown (not inspected by the native CLI)");
                            println!("  PDF/A: unknown (not validated by the native CLI)");
                            println!("  form fields: unknown, comments: unknown (not inspected by the native CLI)");
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
        }

        Commands::Redact(args) => {
            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };

            for pat in &args.pattern {
                let resolved = resolve_pattern(pat);
                if Regex::new(resolved).is_err() {
                    eprintln!("\"{pat}\" is not a valid pattern. Use email, phone, card, date, url, or a regular expression.");
                    return ExitCode::from(2);
                }
            }

            if args.pattern.is_empty() && args.term.is_empty() {
                eprintln!("Give at least one --pattern or --term.");
                return ExitCode::from(2);
            }

            let mut regexes = Vec::new();
            for pat in &args.pattern {
                let resolved = resolve_pattern(pat);
                regexes.push(Regex::new(resolved).unwrap());
            }
            let many = files.len() > 1;

            for file in &files {
                match fs::read(file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(mut pdf) => {
                            let count = pdf.redact(&regexes, &args.term);
                            let saved_bytes = match pdf.save() {
                                Ok(b) => b,
                                Err(e) => {
                                    eprintln!("{}: {}", file.display(), e);
                                    failed += 1;
                                    continue;
                                }
                            };
                            let out_path = output_path(file, "redacted", cli.out.as_deref(), many, "pdf");
                            if let Err(e) = fs::write(&out_path, saved_bytes) {
                                eprintln!("{}: {}", file.display(), e);
                                failed += 1;
                                continue;
                            }
                            say(&format!("{}: removed {} matches", out_path.display(), count));
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
            if many && !quiet {
                println!("Done: {} of {} files", files.len() - failed, files.len());
            }
        }

        Commands::Stamp(args) => {
            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };

            let template = match args.text {
                Some(t) => t,
                None => {
                    eprintln!("Give the stamp text with --text.");
                    return ExitCode::from(2);
                }
            };

            let position = match args.position.parse::<StampPosition>() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::from(2);
                }
            };

            let font_size = args.size.parse::<f32>().unwrap_or(10.0);
            let mut bates = args.bates_start;
            let many = files.len() > 1;

            for file in &files {
                match fs::read(file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(mut pdf) => {
                            let spec = StampSpec {
                                template: template.clone(),
                                position,
                                size: font_size,
                                bates_start: Some(bates),
                                bates_digits: Some(6),
                            };
                            let pages = pdf.page_count();
                            if let Err(e) = pdf.stamp(&spec, &mut bates) {
                                eprintln!("{}: {}", file.display(), e);
                                failed += 1;
                                continue;
                            }
                            let saved_bytes = match pdf.save() {
                                Ok(b) => b,
                                Err(e) => {
                                    eprintln!("{}: {}", file.display(), e);
                                    failed += 1;
                                    continue;
                                }
                            };
                            let out_path = output_path(file, "stamped", cli.out.as_deref(), many, "pdf");
                            if let Err(e) = fs::write(&out_path, saved_bytes) {
                                eprintln!("{}: {}", file.display(), e);
                                failed += 1;
                                continue;
                            }
                            say(&format!("{}: stamped {} pages", out_path.display(), pages));
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
            if many && !quiet {
                println!("Done: {} of {} files", files.len() - failed, files.len());
            }
        }

        Commands::Sign(args) => {
            if args.timestamp.is_some() {
                return unavailable("Timestamped signing");
            }
            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };

            let p12_path = match args.p12 {
                Some(p) => p,
                None => {
                    eprintln!("Give your digital ID with --p12.");
                    return ExitCode::from(2);
                }
            };
            let p12_bytes = match fs::read(&p12_path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("{}: {}", p12_path.display(), e);
                    return ExitCode::from(2);
                }
            };
            let password = args.password.unwrap_or_default();
            let many = files.len() > 1;

            for file in &files {
                match fs::read(file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(mut pdf) => {
                            match pdf.sign(&p12_bytes, &password, args.reason.as_deref(), args.location.as_deref()) {
                                Ok(signed_bytes) => {
                                    let out_path = output_path(file, "signed", cli.out.as_deref(), many, "pdf");
                                    if let Err(e) = fs::write(&out_path, signed_bytes) {
                                        eprintln!("{}: {}", file.display(), e);
                                        failed += 1;
                                        continue;
                                    }
                                    say(&format!("{}: signed", out_path.display()));
                                }
                                Err(e) => {
                                    eprintln!("{}: {}", file.display(), e);
                                    failed += 1;
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
            if many && !quiet {
                println!("Done: {} of {} files", files.len() - failed, files.len());
            }
        }

        Commands::Run(args) => {
            let wf_json = match fs::read_to_string(&args.workflow_file) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}: {}", args.workflow_file.display(), e);
                    return ExitCode::from(2);
                }
            };
            let workflow = match parse_workflow(&wf_json) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::from(2);
                }
            };

            // Validate every step before processing any file. The native engine only
            // implements this subset; silently skipping a step produces misleading output.
            if workflow.version != 1 {
                eprintln!("Unsupported workflow version: {}", workflow.version);
                return ExitCode::from(2);
            }
            for (index, step) in workflow.steps.iter().enumerate() {
                match step {
                    WorkflowStep::SetMeta { .. } => {}
                    _ => return unavailable(&format!("Workflow step {}", index + 1)),
                }
            }

            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };
            let many = files.len() > 1;

            for file in &files {
                match fs::read(file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(mut pdf) => {
                            for step in &workflow.steps {
                                match step {
                                    WorkflowStep::SetMeta { meta } => {
                                        pdf.set_metadata(meta);
                                    }
                                    _ => unreachable!("unsupported workflow steps rejected before processing"),
                                }
                            }

                            let saved_bytes = match pdf.save() {
                                Ok(b) => b,
                                Err(e) => {
                                    eprintln!("{}: {}", file.display(), e);
                                    failed += 1;
                                    continue;
                                }
                            };
                            let suffix = workflow.name.to_lowercase().replace(|c: char| !c.is_alphanumeric(), "-");
                            let out_path = output_path(file, &suffix, cli.out.as_deref(), many, "pdf");
                            if let Err(e) = fs::write(&out_path, saved_bytes) {
                                eprintln!("{}: {}", file.display(), e);
                                failed += 1;
                                continue;
                            }
                            say(&format!("{}: ran {}", out_path.display(), workflow.name));
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
            if many && !quiet {
                println!("Done: {} of {} files", files.len() - failed, files.len());
            }
        }

        Commands::Merge(args) => {
            let out_dest = match cli.out {
                Some(o) => o,
                None => {
                    eprintln!("Name the merged file with --out.");
                    return ExitCode::from(2);
                }
            };

            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };

            let first_bytes = match fs::read(&files[0]) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("{}: {}", files[0].display(), e);
                    return ExitCode::from(1);
                }
            };

            let mut merged = match PdfDocument::open(files[0].display().to_string(), &first_bytes) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("{}: {}", files[0].display(), e);
                    return ExitCode::from(1);
                }
            };

            for file in &files[1..] {
                match fs::read(file) {
                    Ok(b) => {
                        if let Err(e) = merged.append(&b) {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    }
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }

            let final_bytes = match merged.save() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("Failed to save merged file: {}", e);
                    return ExitCode::from(1);
                }
            };

            let out_file = if out_dest.extension().is_some() {
                out_dest
            } else {
                out_dest.join("merged.pdf")
            };

            if let Some(parent) = out_file.parent() {
                let _ = fs::create_dir_all(parent);
            }

            if let Err(e) = fs::write(&out_file, final_bytes) {
                eprintln!("Failed to write merged output {}: {}", out_file.display(), e);
                return ExitCode::from(1);
            }

            say(&format!("Merged {} files into {}", files.len(), out_file.display()));
        }

        Commands::Compress(_) => return unavailable("Compression"),
        Commands::Pdfa(_) => return unavailable("PDF/A conversion"),
        Commands::Tag(_) => return unavailable("Accessibility tagging"),
        Commands::Ocr(_) => return unavailable("OCR"),

        Commands::Export(args) => {
            let to = match args.to {
                Some(t) => t,
                None => {
                    eprintln!("Choose a format with --to txt or html.");
                    return ExitCode::from(2);
                }
            };
            if ["docx", "xlsx"].contains(&to.as_str()) {
                return unavailable("Office export");
            }
            if !["txt", "html"].contains(&to.as_str()) {
                eprintln!("Choose a format with --to txt or html.");
                return ExitCode::from(2);
            }
            let files = match collect_pdf_files(&args.paths, cli.recursive) {
                Ok(f) => f,
                Err((msg, code)) => {
                    eprintln!("{msg}");
                    return ExitCode::from(code);
                }
            };
            let many = files.len() > 1;
            for file in &files {
                match fs::read(file) {
                    Ok(bytes) => match PdfDocument::open(file.display().to_string(), &bytes) {
                        Ok(pdf) => {
                            let pages: Vec<u32> = pdf.doc.get_pages().keys().copied().collect();
                            let text = match pdf.doc.extract_text(&pages) {
                                Ok(text) => text,
                                Err(error) => {
                                    eprintln!("{}: text extraction failed: {}", file.display(), error);
                                    failed += 1;
                                    continue;
                                }
                            };
                            let content = if to == "html" { text_html(&text) } else { text };
                            let out_path = output_path(file, "export", cli.out.as_deref(), many, &to);
                            if let Err(error) = fs::write(&out_path, content.as_bytes()) {
                                eprintln!("{}: {}", out_path.display(), error);
                                failed += 1;
                                continue;
                            }
                            say(&format!("{}", out_path.display()));
                        }
                        Err(e) => {
                            eprintln!("{}: {}", file.display(), e);
                            failed += 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("{}: {}", file.display(), e);
                        failed += 1;
                    }
                }
            }
        }
    }

    if failed > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::from(0)
    }
}

