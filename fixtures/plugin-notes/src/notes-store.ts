/** One note, as the plugin's own store keeps it. */
export type Note = {
  readonly id: string;
  readonly text: string;
  readonly writtenAt: Date;
};

/** The notes plugin's state. In memory: the fixture proves the contract, not storage. */
export class NotesStore {
  private readonly notes = new Map<string, Note>();

  write(note: Note): void {
    this.notes.set(note.id, note);
  }

  find(id: string): Note | undefined {
    return this.notes.get(id);
  }

  count(): number {
    return this.notes.size;
  }

  /** Delete notes written before `cutoff`; returns how many went. */
  pruneBefore(cutoff: Date): number {
    let pruned = 0;
    for (const [id, note] of this.notes) {
      if (note.writtenAt < cutoff) {
        this.notes.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }
}
