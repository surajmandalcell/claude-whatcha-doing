export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'
/** activeForm: Claude's "Building X" line while the task runs; description: what TaskCreate said to do. at: when it last changed (ms). */
export type Todo = { text: string; status: TodoStatus; id?: string; activeForm?: string; description?: string; at?: number }
/** One plan line: a section heading (mark "#"), or an item ("1.", "·") at its nesting depth from 0. */
export type PlanStep = { text: string; depth: number; mark: string }
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
  /** The prompt that opened this thread (first 300 chars, one line): its shown name. */
  first?: string
  /** The on-device model's 4-8 word gist of `first`, shown in its place unless the band shows raw prompts. */
  gist?: string
  /** A 3-6 word name the on-device model wrote from the first prompt; the title stands in without it. */
  name?: string
  /** The steps of the last plan Claude wrote for this thread (ExitPlanMode). */
  plan?: PlanStep[]
  /** Milliseconds since the epoch: the first and the last thing seen on this thread. */
  startedAt?: number
  lastAt?: number
  /** When the owner last sent a prompt to this thread (ms), shown as "sent 10:42". */
  sentAt?: number
}
export type Activity = {
  kind: 'prompt' | 'return' | 'edit' | 'test' | 'error' | 'agent' | 'todo' | 'commit'
  text: string
  thread: number
  /** A prompt's 4-8 word gist by the on-device model, shown in its place unless the band shows raw prompts; '' when the model gave none. */
  gist?: string
  /** The newest prompt's 3-6 word gist for the S row. */
  brief?: string
  /** The on-device model never answered (error or timeout, after the retries): gist is '' and the next session asks again. */
  failed?: boolean
  /** When it happened (ms); absent on entries rebuilt from the transcript. */
  at?: number
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
  /** Where Haiku took it from: "#3" a thread, "#3.2" its 2nd todo. Sorts the board newest first. */
  ref?: string
}
export type Summary = { percent: number; tasks: SummaryTask[]; blockers: string[]; remaining: string[] }
/** startedAt: when the running Haiku call began (ms), for the progress bar. */
export type SummaryCache = { key: string; summary?: Summary; error?: string; isLoading?: boolean; startedAt?: number }
export type Tab = 'threads' | 'summary' | 'artifacts'
/** The band: S one row (collapsed), M 6 body rows (compact), L opened up (expanded), or a single icon (min). all: "show all" grows the band to every row the engine gives. scroll: how many rows ▲ moved the timeline back from the newest (0: the newest in view). raw: prompt and thread rows show the prompts as typed, not their on-device gist. */
export type Band = { mode: 'collapsed' | 'compact' | 'expanded' | 'min'; all?: boolean; scroll?: number; raw?: boolean }
/** One Artifact this project published: first seen and last published, in ms since the epoch. */
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
