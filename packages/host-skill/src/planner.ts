export interface DraftDiff {
  added: string[];
  removed: string[];
}

export interface TasksDraft {
  revision: number;
  source: string;
  diff: DraftDiff;
}

function lineDiff(previous: string, next: string): DraftDiff {
  const previousLines = new Set(previous.split(/\r?\n/u));
  const nextLines = new Set(next.split(/\r?\n/u));
  return {
    added: [...nextLines].filter((line) => !previousLines.has(line)),
    removed: [...previousLines].filter((line) => !nextLines.has(line))
  };
}

export class PlanningSession {
  private drafts: TasksDraft[] = [];

  public revise(source: string): TasksDraft {
    if (source.trim().length === 0) throw new Error("tasks.md draft must not be empty");
    const previous = this.drafts.at(-1)?.source ?? "";
    const draft: TasksDraft = {
      revision: this.drafts.length + 1,
      source,
      diff: lineDiff(previous, source)
    };
    this.drafts.push(draft);
    return structuredClone(draft);
  }

  public current(): TasksDraft {
    const draft = this.drafts.at(-1);
    if (draft === undefined) throw new Error("No tasks.md draft exists");
    return structuredClone(draft);
  }
}
