/**
 * What other systems do when an instance comes and goes: enrol it somewhere
 * (a certificate authority, an inventory), and release it again. The
 * `instances` feature calls every configured hook, in name order.
 *
 * `prepare` runs just before the instance is made. What it returns joins the
 * instance's cloud-init (it may carry a one-time enrolment token: the user
 * data is cleared once the instance runs, and it is never stored). Throwing
 * stops the create before anything is made.
 */
import type { ComputeInstance } from "./compute.ts";

export interface InstanceDraft {
  hostname: string;
  region: string;
  networks: readonly string[];
}

export interface InstanceHook {
  prepare?(draft: InstanceDraft): Promise<{ userData?: string }>;
  /** The instance runs and has its addresses and records. */
  created?(instance: ComputeInstance): Promise<void>;
  /** Before deleting; throwing refuses the delete with the hook's reason. */
  beforeDestroy?(instance: ComputeInstance): Promise<void>;
  destroyed?(instance: ComputeInstance): Promise<void>;
}
