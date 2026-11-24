export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'
export type Todo = { text: string; status: TodoStatus; id?: string }
export type Thread = {
  id: number
  title: string
  /** The thread this one branched off: a tangent. */
  parent?: number
  /** done: changed or tested something; answered: a read-only question got its answer. */
  state: 'active' | 'paused' | 'done' | 'answered'
  todos: Todo[]
  files: string[]
  /** The owner's last prompt to this thread, as typed (first 300 chars). */
  prompt?: string
  /** Milliseconds since the epoch: the first and the last thing seen on this thread. */
  startedAt?: number
  lastAt?: number
}
export type Activity = {
  kind: 'prompt' | 'return' | 'edit' | 'test' | 'error' | 'agent' | 'todo' | 'commit'
  text: string
  thread: number
}
export type Observed = {
  threads: Thread[]
  current: number
  log: Activity[]
  lastTest?: { ok: boolean; text: string }
}
export type SummaryTask = {
  name: string
  status: 'completed' | 'active' | 'blocked' | 'remaining'
  eli5: string
}
export type Summary = { percent: number; tasks: SummaryTask[]; blockers: string[]; remaining: string[] }
export type SummaryCache = { key: string; summary?: Summary; error?: string; isLoading?: boolean }
export type Tab = 'threads' | 'summary' | 'artifacts'
/** The band: one row, opened up, or a single icon. all: "show all" grows the band to every row the engine gives. */
export type Band = { mode: 'collapsed' | 'expanded' | 'min'; all?: boolean }/** One Artifact this project published: first seen and last published, in ms since the epoch. */
export type ArtifactRow = { url: string; title: string; created: number; modified: number }
/** The project's Artifacts; `key` is the `$.store` key, one per project folder. */
export type Artifacts = { key: string; rows: ArtifactRow[] }

declare module 'claude-code' {
  interface PluginState {
    'whatcha-doing': {
      observed: Shaped<Observed>
      tab: Shaped<Tab>
      summary: Shaped<SummaryCache>
      isDemo: Shaped<boolean>
      band: Shaped<Band>
      artifacts: Shaped<Artifacts>    }
  }
}
