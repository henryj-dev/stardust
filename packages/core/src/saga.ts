/**
 * Sagas: work in named steps against outside systems, where a later step can
 * fail after earlier ones changed something (create an instance, then its DNS
 * record, then …). Each step is recorded as it finishes, so a process that
 * dies mid-way resumes where it stopped; a step that fails undoes the
 * finished steps in reverse. The step names are the saga's history — they
 * are shown to people and must not change once released.
 */

export interface SagaStep<S> {
  /** Shown in the saga's history. Lower-case words joined by "-". */
  name: string;
  /** Does the step and returns the new state. Must be safe to run again if the process died before it was recorded. */
  run(state: S, signal: AbortSignal): Promise<S>;
  /** Undoes the step after a later one failed. Without it the step needs no undoing. */
  compensate?(state: S, signal: AbortSignal): Promise<void>;
}

export interface SagaDefinition<S> {
  /** `<plugin>.<what>`, e.g. `instances.create`. */
  kind: string;
  steps: readonly SagaStep<S>[];
}

export type SagaStatus = "running" | "succeeded" | "compensated" | "compensation-failed";

export interface SagaRecord<S = unknown> {
  id: string;
  kind: string;
  status: SagaStatus;
  /** JSON: it is stored between steps. */
  state: S;
  /** Names of the steps that finished, in order. */
  done: string[];
  /** The step that failed, when one did. */
  failedStep: string | null;
  error: string | null;
}

/** The `sagas` port: where saga records are kept between steps. */
export interface SagaStore {
  create(record: SagaRecord): Promise<void>;
  load(id: string): Promise<SagaRecord | null>;
  save(record: SagaRecord): Promise<void>;
}

const STEP_NAME = /^[a-z][a-z0-9-]*$/;
const KIND = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export function defineSaga<S>(definition: SagaDefinition<S>): SagaDefinition<S> {
  const problems: string[] = [];
  if (!KIND.test(definition.kind)) problems.push(`kind "${definition.kind}" must be <plugin>.<what>`);
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!STEP_NAME.test(step.name)) problems.push(`step "${step.name}" must be lower-case words joined by "-"`);
    if (seen.has(step.name)) problems.push(`step "${step.name}" is declared twice`);
    seen.add(step.name);
  }
  if (definition.steps.length === 0) problems.push("a saga needs at least one step");
  if (problems.length > 0) throw new Error(`saga ${definition.kind}: ${problems.join("; ")}`);
  return definition;
}

/** Records a new saga; `runSaga` then does it. */
export async function startSaga<S>(
  store: SagaStore,
  definition: SagaDefinition<S>,
  id: string,
  state: S,
): Promise<SagaRecord<S>> {
  const record: SagaRecord<S> = {
    id,
    kind: definition.kind,
    status: "running",
    state,
    done: [],
    failedStep: null,
    error: null,
  };
  await store.create(record as SagaRecord);
  return record;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 2000);

/**
 * Runs, or resumes, a saga until it ends. A saga that already ended is
 * returned as it is. When the signal is aborted the saga stops between steps
 * and stays `running`, so the next call resumes it; nothing is undone.
 */
export async function runSaga<S>(
  store: SagaStore,
  definition: SagaDefinition<S>,
  id: string,
  signal: AbortSignal,
): Promise<SagaRecord<S>> {
  const record = (await store.load(id)) as SagaRecord<S> | null;
  if (!record) throw new Error(`no saga ${id}`);
  if (record.kind !== definition.kind) throw new Error(`saga ${id} is a ${record.kind}, not a ${definition.kind}`);
  if (record.status !== "running") return record;

  for (const step of definition.steps) {
    if (record.done.includes(step.name)) continue;
    if (signal.aborted) return record;
    try {
      record.state = await step.run(record.state, signal);
    } catch (err) {
      if (signal.aborted) return record;
      record.failedStep = step.name;
      record.error = message(err);
      await compensate(store, definition, record, signal);
      return record;
    }
    record.done.push(step.name);
    await store.save(record as SagaRecord);
  }
  record.status = "succeeded";
  await store.save(record as SagaRecord);
  return record;
}

async function compensate<S>(
  store: SagaStore,
  definition: SagaDefinition<S>,
  record: SagaRecord<S>,
  signal: AbortSignal,
): Promise<void> {
  const finished = definition.steps.filter((s) => record.done.includes(s.name)).reverse();
  for (const step of finished) {
    if (!step.compensate) continue;
    try {
      await step.compensate(record.state, signal);
    } catch (err) {
      // Someone has to look: the outside system holds what could not be undone.
      record.status = "compensation-failed";
      record.error = `${record.error}; undoing ${step.name} failed: ${message(err)}`.slice(0, 2000);
      await store.save(record as SagaRecord);
      return;
    }
  }
  record.status = "compensated";
  await store.save(record as SagaRecord);
}
