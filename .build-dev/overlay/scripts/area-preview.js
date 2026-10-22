// DBU Automation — non-persistent area template placement for Foundry VTT 12/13.
// The preview is a local Canvas placeable; no Scene Document is created until confirm.
let activePlacement = null;

function validPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function pointerPoint(event, stage) {
  try {
    const local = event?.data?.getLocalPosition?.(stage);
    if (validPoint(local)) return { x: local.x, y: local.y };
    const global = event?.data?.global ?? event?.global;
    const converted = global && stage?.toLocal?.(global);
    if (validPoint(converted)) return { x: converted.x, y: converted.y };
  } catch (error) {
    console.warn("DBU Area | Coordenadas do ponteiro:", error);
  }
  return null;
}

function withinScene(p, dimensions) {
  if (!validPoint(p)) return false;
  const rect = dimensions?.sceneRect;
  if (typeof rect?.contains === "function") return rect.contains(p.x, p.y);
  const x = Number(dimensions?.sceneX ?? 0);
  const y = Number(dimensions?.sceneY ?? 0);
  const w = Number(dimensions?.sceneWidth ?? dimensions?.width ?? 0);
  const h = Number(dimensions?.sceneHeight ?? dimensions?.height ?? 0);
  return p.x >= x && p.y >= y && p.x <= x + w && p.y <= y + h;
}

export function snapTargetSquare(point, grid, dimensions, scene) {
  if (!validPoint(point)) return null;
  if (Number(scene?.grid?.type) === 0) return { x: point.x, y: point.y };
  try {
    const newer = grid?.getCenterPoint?.(point);
    if (validPoint(newer)) return { x: newer.x, y: newer.y };
    const older = grid?.getCenter?.(point.x, point.y);
    if (Array.isArray(older) && older.length >= 2 && older.every(Number.isFinite)) {
      return { x: older[0], y: older[1] };
    }
    if (validPoint(older)) return { x: older.x, y: older.y };
  } catch (error) {
    console.warn("DBU Area | Grid snapping nativo indisponível:", error);
  }
  // Square-grid fallback only; for hex use the native grid methods above.
  if (Number(scene?.grid?.type) !== 1) return { x: point.x, y: point.y };
  const size = Math.max(1, Number(dimensions?.size || grid?.size || 100));
  const ox = Number(dimensions?.sceneX || 0);
  const oy = Number(dimensions?.sceneY || 0);
  return {
    x: ox + (Math.floor((point.x - ox) / size) + .5) * size,
    y: oy + (Math.floor((point.y - oy) / size) + .5) * size
  };
}

function aimDegrees(origin, p) {
  const dx = p.x - origin.x, dy = p.y - origin.y;
  if (Math.hypot(dx, dy) < 2) return null;
  return (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
}

/**
 * Displays the exact MeasuredTemplate with the attack's existing geometry.
 * mode: "aim" (attacker-origin cone/ray), "center" (fixed Sphere),
 *       "place" (Sphere with free Target Square).
 *
 * @returns {Promise<{confirmed:boolean, data?:object}>}
 */
export async function previewMeasuredTemplate({ data, mode = "place" } = {}) {
  // Avoid two queued listeners and two Canvas previews on the same client.
  activePlacement?.cancel?.();
  const scene = canvas?.scene, stage = canvas?.stage, layer = canvas?.templates;
  const previewLayer = layer?.preview;
  const DocClass = CONFIG?.MeasuredTemplate?.documentClass
    ?? globalThis.getDocumentClass?.("MeasuredTemplate")
    ?? globalThis.MeasuredTemplateDocument;
  const PlaceableClass = CONFIG?.MeasuredTemplate?.objectClass
    ?? globalThis.MeasuredTemplate
    ?? globalThis.foundry?.canvas?.placeables?.MeasuredTemplate;
  if (!scene || !stage || !previewLayer?.addChild || !DocClass || !PlaceableClass) {
    ui.notifications.error("DBU Area: prévia indisponível neste Canvas. Ataque cancelado.");
    return { confirmed: false };
  }

  const sceneId = scene.id;
  const initial = { ...data };
  const document = new DocClass(initial, { parent: scene });
  const object = new PlaceableClass(document);
  let done = false, resolveChoice;
  const choice = new Promise(resolve => { resolveChoice = resolve; });
  const finish = value => {
    if (done) return;
    done = true;
    resolveChoice(value);
  };
  const session = { cancel: () => finish(null) };
  activePlacement = session;
  let last = { ...initial };
  let canConfirm = mode === "center";
  let attached = false;
  const handlers = [];

  const on = (emitter, event, handler) => {
    emitter?.on?.(event, handler);
    handlers.push(() => emitter?.off?.(event, handler));
  };
  const onDom = (target, event, handler, options) => {
    target?.addEventListener?.(event, handler, options);
    handlers.push(() => target?.removeEventListener?.(event, handler, options));
  };
  const onHook = (event, handler) => {
    const id = globalThis.Hooks?.on?.(event, handler);
    if (id != null) handlers.push(() => globalThis.Hooks?.off?.(event, id));
  };

  function applyPointer(point) {
    if (!validPoint(point) || !withinScene(point, canvas?.dimensions)) {
      if (mode !== "center") canConfirm = false;
      return;
    }
    const updates = {};
    if (mode === "place") {
      const snapped = snapTargetSquare(point, canvas?.grid, canvas?.dimensions, scene);
      if (!withinScene(snapped, canvas?.dimensions)) { canConfirm = false; return; }
      updates.x = snapped.x;
      updates.y = snapped.y;
    } else if (mode === "aim") {
      const degrees = aimDegrees(initial, point);
      if (degrees === null) { canConfirm = false; return; }
      updates.direction = degrees;
    }
    canConfirm = true;
    if (Object.keys(updates).length) {
      last = { ...last, ...updates };
      document.updateSource(updates);
      // RefreshShape is needed for cone/ray rotation in both Foundry versions.
      if (object.renderFlags?.set) object.renderFlags.set({ refresh: true });
      else object.refresh?.();
    }
  }

  const onMove = event => applyPointer(pointerPoint(event, stage));
  const onClick = event => {
    if (Number(event?.button ?? event?.data?.button ?? 0) !== 0) return;
    if (canvas?.scene?.id !== sceneId || !canConfirm) return;
    if (mode !== "center") applyPointer(pointerPoint(event, stage));
    if (!canConfirm) return;
    event?.stopPropagation?.();
    finish({ ...last });
  };
  const onRight = event => {
    event?.stopPropagation?.();
    finish(null);
  };
  const onEsc = event => {
    if (event.key !== "Escape") return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    finish(null);
  };
  const onContext = event => {
    event.preventDefault?.();
    event.stopPropagation?.();
    finish(null);
  };

  try {
    previewLayer.addChild(object);
    attached = true;
    object.eventMode = "none";
    object.interactive = false;
    await object.draw();
    if (done) return { confirmed: false };
    on(stage, "pointermove", onMove);
    on(stage, "pointerdown", onClick);
    on(stage, "rightdown", onRight);
    onDom(globalThis.window, "keydown", onEsc, true);
    const canvasView = canvas?.app?.view ?? canvas?.app?.canvas;
    onDom(canvasView, "contextmenu", onContext, true);
    onHook("canvasTearDown", () => finish(null));
    ui.notifications.info("DBU Area: mova o mouse para visualizar; clique para confirmar, Esc ou botão direito para cancelar.");
    const selected = await choice;
    return selected ? { confirmed: true, data: selected } : { confirmed: false };
  } catch (error) {
    console.error("DBU Area | Falha ao exibir prévia:", error);
    ui.notifications.error("Não foi possível exibir a prévia do template; ataque cancelado.");
    return { confirmed: false };
  } finally {
    for (const cleanup of handlers.reverse()) {
      try { cleanup(); } catch (error) { console.warn("DBU Area | Limpando listener:", error); }
    }
    if (attached) {
      try { object.parent?.removeChild?.(object); } catch {}
      try { object.destroy?.({ children: true }); } catch {}
    }
    if (activePlacement === session) activePlacement = null;
  }
}
