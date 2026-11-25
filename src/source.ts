/**
 * Where the tools get their mailbox: Google, through the stored authorization — or, after
 * `enterDemoMode()`, the in-memory demo mailbox. One switch for the whole process, set once at
 * startup by `--demo` and never turned back, so no call can reach Google in a run that started as
 * a demo, and no demo answer can appear in a run that did not.
 */
import { getAuth } from "./auth.js";
import { Gmail } from "./gmail.js";
import { createDemoMailbox, demoUnsubscribeDeps, type DemoMailbox } from "./demo-api.js";
import { defaultUnsubscribeDeps, type UnsubscribeDeps } from "./unsubscribe.js";

let demo: DemoMailbox | undefined;

/** Serve the demo mailbox from now on. Idempotent: the mailbox is created once per process. */
export function enterDemoMode(now: number = Date.now()): DemoMailbox {
  demo ??= createDemoMailbox(now);
  return demo;
}

/** Whether this process serves the demo mailbox. */
export function demoMode(): boolean {
  return demo !== undefined;
}

/** A Gmail client for one call: fresh auth per call for Google, the one mailbox for the demo. */
export async function gmailClient(): Promise<Gmail> {
  return demo ? new Gmail(demo.api()) : new Gmail(await getAuth(false));
}

/** The network the unsubscribe tools use: the real one, or the demo's, which never leaves. */
export function unsubscribeDeps(): UnsubscribeDeps {
  return demo ? demoUnsubscribeDeps : defaultUnsubscribeDeps;
}

/** Tests only: leave demo mode again. */
export function leaveDemoModeForTests(): void {
  demo = undefined;
}
