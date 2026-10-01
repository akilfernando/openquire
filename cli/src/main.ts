/**
 * openquire: the OpenQuire PDF engine on the command line.
 *
 * Every command takes PDF files or folders of them, works on each file in turn, and writes the
 * result next to the input (or into --out), so it is safe to run on a folder of originals.
 */
import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { Engine } from '../../src/engine/core'
import { REDACTION_PATTERNS, type PatternName } from '../../src/engine/patterns'
import { parseWorkflow } from '../../src/engine/workflow'
import type { CompressLevel, StampPosition } from '../../src/engine/types'
import { recognize, stopOcr } from './ocr'

declare const VERSION: string

const HELP = `openquire ${VERSION}: PDF tools from OpenQuire

Usage: openquire <command> <files or folders...> [options]

Commands:
  info       Show pages, properties, signatures, tags and PDF/A status
  redact     Find and permanently remove text
               --pattern <name|regex>  email, phone, card, date, url, or a regular expression (repeatable)
               --term <text>           exact text to remove (repeatable)
  stamp      Add text to pages: page numbers, Bates numbers, watermarks
               --text <template>       may use {page}, {pages}, {date}, {name}, {bates}
               --position <pos>        tl, tc, tr, bl, bc, br or center (default bc)
               --size <points>         font size, or "fit" (default 10)
               --bates-start <n>       first Bates number; it continues across files (default 1)
  ocr        Recognize text on pages without text
               --lang <code>           eng (built in), fra, deu, spa, ita, por, nld, ... (downloaded once)
  sign       Sign with a digital ID
               --p12 <file>            certificate and key (.p12 or .pfx)
               --password <text>       or set OPENQUIRE_P12_PASSWORD
               --reason <text>  --location <text>  --timestamp <url>
  run        Run a workflow saved from the app on each file
               openquire run workflow.json <files or folders...>
  merge      Combine files into one: openquire merge a.pdf b.pdf -o all.pdf
  compress   Save smaller files: --level standard|medium|strong (default medium)
  pdfa       Save PDF/A copies: --part 2|3 (default 2)
  tag        Tag for accessibility: --lang <BCP 47 code> (default en-US)
  export     Convert: --to docx|xlsx|txt|html

Options:
  -o, --out <path>   Output folder (or file, for one input or merge). Default: next to each input
  -r, --recursive    Include PDFs in subfolders
  -q, --quiet        Only print errors
  -h, --help         Show this help
  -v, --version      Show the version
`

const COMMANDS = ['info', 'redact', 'stamp', 'ocr', 'sign', 'run', 'merge', 'compress', 'pdfa', 'tag', 'export'] as const
type Command = (typeof COMMANDS)[number]

class UsageError extends Error {}

/** PDF files named on the command line, with folders expanded. */
function collect(paths: string[], recursive: boolean): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (recursive) walk(p)
      } else if (extname(name).toLowerCase() === '.pdf') out.push(p)
    }
  }
  for (const p of paths) {
    if (!existsSync(p)) throw new UsageError(`No such file or folder: ${p}`)
    if (statSync(p).isDirectory()) walk(p)
    else out.push(p)
  }
  return out
}

function outputPath(input: string, suffix: string, out: string | undefined, many: boolean, ext = '.pdf') {
  const name = `${basename(input, extname(input))}${out ? '' : `-${suffix}`}${ext}`
  if (!out) return join(dirname(input), name)
  // A single input may be written to a named file; otherwise --out is a folder.
  if (!many && extname(out).toLowerCase() === ext) {
    mkdirSync(dirname(resolve(out)), { recursive: true })
    return out
  }
  mkdirSync(out, { recursive: true })
  return join(out, name)
}

function open(file: string) {
  const e = new Engine()
  const state = e.open(basename(file), new Uint8Array(readFileSync(file)))
  return { e, state }
}

const save = (e: Engine, compress: CompressLevel = 'standard') => e.save({ compress, security: { mode: 'keep' } })

export async function main(argv: string[], log: (s: string) => void = console.log, error: (s: string) => void = console.error): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        recursive: { type: 'boolean', short: 'r' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        pattern: { type: 'string', multiple: true },
        term: { type: 'string', multiple: true },
        text: { type: 'string' },
        position: { type: 'string' },
        size: { type: 'string' },
        'bates-start': { type: 'string' },
        lang: { type: 'string' },
        p12: { type: 'string' },
        password: { type: 'string' },
        reason: { type: 'string' },
        location: { type: 'string' },
        timestamp: { type: 'string' },
        level: { type: 'string' },
        part: { type: 'string' },
        to: { type: 'string' },
      },
    })
  } catch (e) {
    error((e as Error).message)
    return 2
  }
  const { values: o, positionals } = parsed
  if (o.version) {
    log(VERSION)
    return 0
  }
  const [command, ...rest] = positionals
  if (o.help || !command) {
    log(HELP)
    return command || o.help ? 0 : 2
  }
  if (!COMMANDS.includes(command as Command)) {
    error(`Unknown command "${command}". Run openquire --help to see the commands.`)
    return 2
  }
  const say = (s: string) => !o.quiet && log(s)

  try {
    let workflow = null
    let inputs = rest
    if (command === 'run') {
      if (!rest[0]) throw new UsageError('Name the workflow file: openquire run workflow.json <files>')
      workflow = parseWorkflow(readFileSync(rest[0], 'utf8'))
      inputs = rest.slice(1)
    }
    const files = collect(inputs, !!o.recursive)
    if (!files.length) throw new UsageError('No PDF files given.')
    const many = files.length > 1

    if (command === 'merge') {
      if (!o.out) throw new UsageError('Name the merged file with --out.')
      const e = new Engine()
      e.open(basename(files[0]), new Uint8Array(readFileSync(files[0])))
      for (const f of files.slice(1)) e.append(basename(f), new Uint8Array(readFileSync(f)))
      const out = extname(o.out) ? o.out : join(o.out, 'merged.pdf')
      mkdirSync(dirname(resolve(out)), { recursive: true })
      writeFileSync(out, save(e))
      say(`Merged ${files.length} files into ${out}`)
      return 0
    }

    // Checked once up front, so a mistake doesn't surface after half the files are done.
    const patterns = (o.pattern ?? []).map((p) => (p in REDACTION_PATTERNS ? REDACTION_PATTERNS[p as PatternName] : p))
    for (const p of patterns) {
      try {
        new RegExp(p)
      } catch {
        throw new UsageError(`"${p}" is not a valid pattern. Use email, phone, card, date, url, or a regular expression.`)
      }
    }
    if (command === 'redact' && !patterns.length && !o.term?.length) throw new UsageError('Give at least one --pattern or --term.')
    if (command === 'stamp' && !o.text) throw new UsageError('Give the stamp text with --text.')
    if (command === 'sign' && !o.p12) throw new UsageError('Give your digital ID with --p12.')
    if (command === 'export' && !['docx', 'xlsx', 'txt', 'html'].includes(o.to ?? '')) throw new UsageError('Choose a format with --to docx, xlsx, txt or html.')
    const position = (o.position ?? 'bc') as StampPosition
    if (command === 'stamp' && !['tl', 'tc', 'tr', 'bl', 'bc', 'br', 'center'].includes(position)) throw new UsageError(`Unknown position "${position}".`)
    const p12 = o.p12 ? new Uint8Array(readFileSync(o.p12)) : null
    const password = o.password ?? process.env.OPENQUIRE_P12_PASSWORD ?? ''

    let failed = 0
    let bates = Number(o['bates-start'] ?? 1)
    for (const file of files) {
      try {
        const { e, state } = open(file)
        const write = (suffix: string, bytes: Uint8Array | string, ext = '.pdf') => {
          const out = outputPath(file, suffix, o.out, many, ext)
          writeFileSync(out, bytes)
          return out
        }
        switch (command as Command) {
          case 'info': {
            const pdf = e.checkPdfA()
            const a11y = e.checkAccessibility()
            log(`${file}`)
            log(`  pages: ${state.pages.length}${state.encrypted ? ', password protected' : ''}`)
            for (const [k, v] of Object.entries(state.meta)) if (v) log(`  ${k}: ${v}`)
            log(`  signatures: ${state.signatures.length ? state.signatures.map((s) => `${s.signer} (${s.valid ? (s.trust.trusted ? 'valid' : 'valid, not trusted') : 'invalid'})`).join('; ') : 'none'}`)
            log(`  tagged: ${a11y.tagged ? 'yes' : 'no'}${a11y.problems.length ? ` (${a11y.problems.filter((p) => p.severity === 'error').length} accessibility problems)` : ''}`)
            log(`  PDF/A: ${pdf.part && !pdf.problems.length ? `PDF/A-${pdf.part}b` : 'no'}`)
            log(`  form fields: ${state.pages.reduce((n, p) => n + p.widgets.length, 0)}, comments: ${state.pages.reduce((n, p) => n + p.annots.length, 0)}`)
            break
          }
          case 'redact': {
            let marked = 0
            for (const p of patterns) marked += e.markPattern(p).count
            if (o.term?.length) marked += e.markForRedaction(o.term).count
            const { count } = e.applyRedactions()
            say(`${write('redacted', save(e))}: removed ${count} of ${marked} matches`)
            break
          }
          case 'stamp': {
            const size = o.size === 'fit' ? 'fit' : Number(o.size ?? 10)
            const r = e.runStep(
              { action: 'stamp', pages: 'all', stamp: { template: o.text!, position, size, color: [0, 0, 0], opacity: 1, angle: 0, batesDigits: 6 } },
              { bates },
            )
            bates = r.bates ?? bates
            say(`${write('stamped', save(e))}: stamped ${state.pages.length} pages`)
            break
          }
          case 'ocr': {
            const n = await recognize(e, o.lang ?? 'eng')
            say(`${write('ocr', save(e))}: recognized text on ${n} pages`)
            break
          }
          case 'sign': {
            const { bytes } = await e.sign({ p12: p12!, password, pageId: null, reason: o.reason, location: o.location, timestampUrl: o.timestamp })
            say(`${write('signed', bytes)}: signed`)
            break
          }
          case 'run': {
            let output: Uint8Array | null = null
            for (const step of workflow!.steps) {
              if (step.action === 'ocr') {
                if (step.straighten) e.straighten(e.pagesWithoutText())
                await recognize(e, step.lang && step.lang !== 'auto' ? step.lang : 'eng')
                continue
              }
              const r = e.runStep(step, { bates })
              bates = r.bates ?? bates
              if (r.bytes) output = r.bytes
            }
            say(`${write(workflow!.name.toLowerCase().replace(/[^\w]+/g, '-'), output ?? save(e))}: ran ${workflow!.name}`)
            break
          }
          case 'compress': {
            const level = (o.level ?? 'medium') as CompressLevel
            if (!['standard', 'medium', 'strong'].includes(level)) throw new UsageError(`Unknown level "${level}".`)
            const before = statSync(file).size
            const bytes = save(e, level)
            say(`${write('compressed', bytes)}: ${Math.round(before / 1024)} KB to ${Math.round(bytes.length / 1024)} KB`)
            break
          }
          case 'pdfa': {
            const part = Number(o.part ?? 2) as 2 | 3
            const { bytes, notes } = e.convertToPdfA(part)
            say(`${write(`pdfa${part}`, bytes)}${notes.length ? `: ${notes.join(' ')}` : ''}`)
            break
          }
          case 'tag': {
            const { notes } = e.autoTag(o.lang ?? 'en-US')
            say(`${write('tagged', save(e))}${notes.length ? `: ${notes.join(' ')}` : ''}`)
            break
          }
          case 'export': {
            const to = o.to!
            if (to === 'docx') say(write('export', e.exportDocx(), '.docx'))
            else if (to === 'html') say(write('export', e.exportHtml(), '.html'))
            else if (to === 'txt') say(write('export', e.exportText(), '.txt'))
            else {
              const x = e.exportXlsx()
              say(x ? write('export', x, '.xlsx') : `${file}: no tables found`)
            }
            break
          }
        }
      } catch (err) {
        if (err instanceof UsageError) throw err
        failed++
        const msg = (err as Error).name === 'PasswordError' ? 'it is password protected' : (err as Error).message
        error(`${file}: ${msg}`)
      }
    }
    if (many && !o.quiet && command !== 'info') log(`Done: ${files.length - failed} of ${files.length} files`)
    return failed ? 1 : 0
  } catch (e) {
    error((e as Error).message)
    return e instanceof UsageError ? 2 : 1
  } finally {
    await stopOcr()
  }
}
