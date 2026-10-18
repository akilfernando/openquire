import { useState } from 'react'
import { ArrowUpRight, FileText, FolderOpen, Layers, PenLine, ScanText, Search, ShieldCheck, Signature, Workflow } from 'lucide-react'
import { m } from '../i18n'
import { fileName } from '../native'

const icons = [PenLine, Layers, ScanText, Signature, ShieldCheck, Workflow]

export default function Home({ onOpen, onBlank, onCommands, recent, onRecent, openShortcut }: {
  onOpen: () => void; onBlank: () => void; onCommands: () => void
  recent: string[]; onRecent: (path: string) => void; openShortcut?: string
}) {
  const [query, setQuery] = useState('')
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = m.home.groups.map((group, index) => ({ ...group, index })).filter(group =>
    words.every(word => `${group.title} ${group.description} ${group.tools} ${group.hint}`.toLocaleLowerCase().includes(word)))
  return <main className="home" aria-labelledby="home-title">
    <div className="home-content">
      <header className="home-hero">
        <div className="home-eyebrow">{m.home.eyebrow}</div>
        <h1 id="home-title">{m.home.title}</h1>
        <p className="home-description">{m.home.description}</p>
        <div className="home-actions">
          <button className="home-primary" onClick={onOpen}><FolderOpen size={19} />{m.workspace.emptyOpen}{openShortcut && <kbd>{openShortcut}</kbd>}</button>
          <button onClick={onBlank}>{m.workspace.emptyBlank}</button>
        </div>
        <p className="home-drop">{m.home.drop}</p>
      </header>
      <section aria-labelledby="home-tools">
        <div className="home-section-heading"><h2 id="home-tools">{m.home.tools}</h2><button onClick={onCommands}>{m.actions.commandPalette}<ArrowUpRight size={15} /></button></div>
        <label className="home-search"><Search size={18} /><span className="sr-only">{m.home.search}</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={m.home.placeholder} /></label>
        <div className="home-tools">
          {groups.map(group => { const Icon = icons[group.index]; return <details className="home-tool" key={group.title}>
            <summary><Icon size={22} /><span><h3>{group.title}</h3><span className="home-tool-description">{group.description}</span></span><span className="home-expand" aria-hidden="true">+</span></summary>
            <p className="home-tool-keywords">{group.tools}</p>
            <div className="home-tool-detail"><p>{group.hint}</p><button onClick={onOpen}>{m.home.start}<ArrowUpRight size={15} /></button></div>
          </details> })}
        </div>
        {groups.length === 0 && <div className="home-no-results" role="status"><p>{m.home.empty}</p><button onClick={() => setQuery('')}>{m.home.clear}</button></div>}
      </section>
      {recent.length > 0 && <section aria-labelledby="home-recent"><h2 id="home-recent">{m.workspace.recent}</h2><div className="home-recents">{recent.map(path => <button key={path} title={path} onClick={() => onRecent(path)}><FileText size={18} /><span>{fileName(path)}</span></button>)}</div></section>}
      <footer className="home-privacy"><ShieldCheck size={17} /><p>{m.home.privacy}</p></footer>
    </div>
  </main>
}
