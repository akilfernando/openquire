/** Workspace save checkpoints are tied to content, never to the active tab. */
export class DocumentSessions {
  private sessions = new Map<number, { revision: string; saved: string | null }>()

  open(id: number, revision: string, alreadySaved: boolean): void {
    this.sessions.set(id, { revision, saved: alreadySaved ? revision : null })
  }

  update(id: number, revision: string): void {
    const session = this.sessions.get(id)
    if (session) session.revision = revision
  }

  markSaved(id: number, revision: string): void {
    const session = this.sessions.get(id)
    if (session) session.saved = revision
  }

  dirty(id: number): boolean {
    const session = this.sessions.get(id)
    return !!session && session.revision !== session.saved
  }

  dirtyIds(): number[] {
    return [...this.sessions.keys()].filter((id) => this.dirty(id))
  }

  has(id: number): boolean { return this.sessions.has(id) }

  close(id: number): void { this.sessions.delete(id) }
}
