// DBU Automation — Transformation event coordination
import { transformationRuntime } from "./state.js";

function actorKey(actor) {
  return String(actor?.id || actor?.uuid || "");
}

export function isTransformationVisualSyncSuppressed(actor) {
  const key = actorKey(actor);
  return key ? Number(transformationRuntime.visualSyncSuppressions.get(key) || 0) > 0 : false;
}

export async function withTransformationVisualSyncSuppressed(actor, operation) {
  const key = actorKey(actor);
  if (!key) return operation();
  const count = Number(transformationRuntime.visualSyncSuppressions.get(key) || 0);
  transformationRuntime.visualSyncSuppressions.set(key, count + 1);
  try {
    return await operation();
  } finally {
    const next = Number(transformationRuntime.visualSyncSuppressions.get(key) || 1) - 1;
    if (next > 0) transformationRuntime.visualSyncSuppressions.set(key, next);
    else transformationRuntime.visualSyncSuppressions.delete(key);
  }
}

export function waitForTransformationState(actor, transIndex, active, timeoutMs = 750) {
  const expected = !!active;
  const matches = () => !!actor?.system?.transformations?.[transIndex]?.active === expected;
  if (matches()) return Promise.resolve(true);

  return new Promise(resolve => {
    let hookId = null;
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (hookId != null) {
        try { Hooks.off("updateActor", hookId); } catch {}
        hookId = null;
      }
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(!!value);
    };

    hookId = Hooks.on("updateActor", updated => {
      if (updated?.id !== actor?.id) return;
      if (matches()) finish(true);
    });

    timer = setTimeout(() => finish(matches()), Math.max(250, Number(timeoutMs) || 750));
  });
}

export function queueTransformationVisualSync(actor, callback) {
  const key = actorKey(actor);
  if (!key || typeof callback !== "function") return false;
  if (transformationRuntime.queuedVisualSync.has(key)) return false;

  transformationRuntime.queuedVisualSync.add(key);
  queueMicrotask(async () => {
    transformationRuntime.queuedVisualSync.delete(key);
    try {
      await callback();
    } catch (error) {
      console.warn("DBU Automation | sync transformation visual:", error);
    }
  });
  return true;
}
