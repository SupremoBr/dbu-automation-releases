// ============================================================
// DBU Automation v1.8.5 TEST — Area Attack / templates (DBU 0.9.2)
// ============================================================
// Fonte de regra: snapshot .ZIM 0.9.2 fornecido pelo mestre.
// AoEs: Sphere, Cone e Line. Magnitudes: Minor (Sphere apenas),
// Standard, Large, Huge, Destructive; Cataclysmic é um caso especial.
// Se um efeito concede uma AoE sem tamanho, ela começa em Standard.
// ============================================================

const VERSION = "1.8.5 TEST";
const MODULE_ID = "dbu-automation-dev";

const MAGNITUDES = Object.freeze({
  0: { value: 0, key: "minor", label: "Minor" },
  1: { value: 1, key: "standard", label: "Standard" },
  2: { value: 2, key: "large", label: "Large" },
  3: { value: 3, key: "huge", label: "Huge" },
  4: { value: 4, key: "destructive", label: "Destructive" },
  5: { value: 5, key: "cataclysmic", label: "Cataclysmic" }
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gridSize() {
  return Math.max(1, num(canvas?.dimensions?.size ?? canvas?.grid?.size, 100));
}

function gridDistance() {
  return Math.max(0.0001, num(canvas?.scene?.grid?.distance ?? canvas?.dimensions?.distance, 1));
}

function tokenCenter(token) {
  if (token?.center) return { x: token.center.x, y: token.center.y };
  const d = token?.document || token;
  const size = gridSize();
  return {
    x: num(d?.x, 0) + num(d?.width, 1) * size / 2,
    y: num(d?.y, 0) + num(d?.height, 1) * size / 2
  };
}

function advantageEntries(source) {
  const list = Array.isArray(source?.advantages) ? source.advantages : [];
  return list.map(entry => {
    if (typeof entry === "string") return { name: entry, ranks: 1, notes: "" };
    return {
      name: String(entry?.name || ""),
      ranks: Math.max(0, num(entry?.ranks ?? entry?.rank ?? entry?.level, 1)),
      notes: String(entry?.notes ?? entry?.note ?? entry?.choice ?? "")
    };
  }).filter(entry => entry.name.trim());
}

function advantage(source, re) {
  return advantageEntries(source).find(entry => re.test(entry.name)) || null;
}

function shapeLabel(shape) {
  return shape === "circle" ? "Sphere" : shape === "cone" ? "Cone" : shape === "ray" ? "Line" : "AoE";
}

export function magnitudeLabel(value) {
  return MAGNITUDES[Math.max(0, Math.min(5, Math.trunc(num(value, 1))))]?.label || "Standard";
}

function magnitudeFromText(text, fallback = 1) {
  const value = String(text || "");
  if (/cataclysmic/i.test(value)) return 5;
  if (/destructive/i.test(value)) return 4;
  if (/\bhuge\b/i.test(value)) return 3;
  if (/\blarge\b/i.test(value)) return 2;
  if (/\bminor\b/i.test(value)) return 0;
  if (/\bstandard\b/i.test(value)) return 1;
  return fallback;
}

function shapeFromText(text) {
  const value = String(text || "");
  if (/sphere/i.test(value)) return "circle";
  if (/cone/i.test(value)) return "cone";
  if (/line/i.test(value)) return "ray";
  return null;
}

/**
 * Best-effort detector. Manual override in the Attack dialog is authoritative.
 * We deliberately do not attempt to guess every triggered Trait/Talent because
 * many 0.9.2 effects are optional and/or paid at the moment of the maneuver.
 */
export function getAreaSpec(source) {
  const profile = String(source?.profile || "").trim();
  const pinfo = CONFIG.DBU?.profileData?.[profile] || source?.profileInfo || {};
  const range = String(pinfo?.range || source?.profileRange || "");
  const reasons = [];
  let spec = { isAoE: false, shape: null, magnitude: 1, centeredOnAttacker: false, excludeAllies: false, source: "none", reasons };

  if (profile === "Sweeping") {
    spec = { ...spec, isAoE: true, shape: "circle", magnitude: 0, centeredOnAttacker: true, excludeAllies: true, source: "profile", reasons: ["Sweeping: Minor Sphere"] };
  } else if (profile === "Blast") {
    spec = { ...spec, isAoE: true, shape: "cone", magnitude: 1, centeredOnAttacker: true, source: "profile", reasons: ["Blast: Standard Cone"] };
  } else if (profile === "Explosion") {
    spec = { ...spec, isAoE: true, shape: "circle", magnitude: 1, centeredOnAttacker: false, source: "profile", reasons: ["Explosion: Standard Sphere"] };
  } else if (profile === "Soaring") {
    spec = { ...spec, isAoE: true, shape: "ray", magnitude: 1, centeredOnAttacker: true, toBattlefieldEdge: true, source: "profile", reasons: ["Soaring: Standard Line (Ki Extension)"] };
  } else {
    const rangeShape = shapeFromText(range);
    if (rangeShape) {
      spec = {
        ...spec,
        isAoE: true,
        shape: rangeShape,
        magnitude: magnitudeFromText(range, 1),
        centeredOnAttacker: rangeShape !== "circle",
        source: "range",
        reasons: [`Range: ${range || `${shapeLabel(rangeShape)} AoE`}`]
      };
    }
  }

  // Ki Extension: Cone or Line starting from the user's square; choice is made
  // when the Advantage is first applied. If Notes preserve the choice, use it.
  // Otherwise mark as a choice and let the Attack dialog decide.
  const kiExtension = advantage(source, /\bKi Extension\b/i);
  if (!spec.isAoE && kiExtension) {
    const chosen = shapeFromText(kiExtension.notes);
    spec = {
      ...spec,
      isAoE: true,
      shape: chosen || "choose",
      magnitude: 1,
      centeredOnAttacker: true,
      source: "advantage",
      reasons: [`Ki Extension${chosen ? `: ${shapeLabel(chosen)}` : ": Cone/Line"}`]
    };
  }

  // Hurricane Assault increases Sweeping from Minor to Standard in the 0.9.2
  // rules snapshot used by this table.
  const hurricane = advantage(source, /\bHurricane Assault\b/i);
  if (spec.isAoE && profile === "Sweeping" && hurricane) {
    spec.magnitude = Math.max(spec.magnitude, 1);
    spec.reasons.push("Hurricane Assault: → Standard");
  }

  // Terrain Destruction: each rank raises AoE Magnitude by one.
  const terrain = advantage(source, /\bTerrain Destruction\b/i);
  if (spec.isAoE && terrain) {
    const ranks = Math.max(1, Math.trunc(num(terrain.ranks, 1)));
    spec.magnitude = Math.min(4, spec.magnitude + ranks);
    spec.reasons.push(`Terrain Destruction ${ranks}: +${ranks} Magnitude`);
  }

  // All Consuming makes an eligible Sphere Cataclysmic.
  const allConsuming = advantage(source, /\bAll Consuming\b/i);
  if (spec.isAoE && allConsuming) {
    spec.shape = "circle";
    spec.magnitude = 5;
    spec.centeredOnAttacker = false;
    spec.source = "advantage";
    spec.reasons.push("All Consuming: Cataclysmic Sphere");
  }

  if (!spec.isAoE) return spec;
  spec.label = `${magnitudeLabel(spec.magnitude)} ${shapeLabel(spec.shape === "choose" ? "" : spec.shape)} AoE`.replace(/\s+AoE$/, " AoE");
  return spec;
}

export function normalizeAreaConfig(config = {}, source = null) {
  const auto = getAreaSpec(source);
  const enabled = config.enabled ?? auto.isAoE;
  let shape = String(config.shape || auto.shape || "circle");
  if (!['circle','cone','ray'].includes(shape)) shape = "circle";
  let magnitude = Math.max(0, Math.min(5, Math.trunc(num(config.magnitude, auto.magnitude ?? 1))));
  if (shape !== "circle" && magnitude === 0) magnitude = 1; // Minor only exists for Sphere.
  const centeredOnAttacker = config.position === "attacker"
    ? true
    : config.position === "map"
      ? false
      : !!auto.centeredOnAttacker;
  return {
    enabled: !!enabled,
    shape,
    magnitude,
    centeredOnAttacker,
    keep: !!config.keep,
    useSelected: !!config.useSelected,
    mode: String(config.mode || (auto.isAoE ? "auto" : "manual")),
    excludeAllies: config.excludeAllies ?? auto.excludeAllies ?? false,
    autoSpec: auto,
    label: `${magnitudeLabel(magnitude)} ${shapeLabel(shape)} AoE`
  };
}

function sceneEdgeSquares() {
  const size = gridSize();
  const w = num(canvas?.dimensions?.width ?? canvas?.scene?.width, size * 30);
  const h = num(canvas?.dimensions?.height ?? canvas?.scene?.height, size * 30);
  return Math.ceil(Math.hypot(w, h) / size) + 2;
}

function geometryFor(config) {
  const mag = Math.max(0, Math.min(5, Math.trunc(num(config?.magnitude, 1))));
  const shape = config?.shape;
  if (mag >= 5) return { cataclysmic: true, squares: sceneEdgeSquares(), widthSquares: sceneEdgeSquares(), angle: 360 };

  if (shape === "circle") {
    // DBU 0.9.2 diagrams: Minor 1; Standard 3; Large 4; Huge 5; Destructive 6 squares.
    const radiusByMagnitude = { 0: 1, 1: 3, 2: 4, 3: 5, 4: 6 };
    return { cataclysmic: false, squares: radiusByMagnitude[mag] ?? 3, widthSquares: 0, angle: 360 };
  }
  if (shape === "cone") {
    // 0.9.2 cone diagram grows one step per magnitude.
    const reachByMagnitude = { 1: 3, 2: 4, 3: 5, 4: 6 };
    return { cataclysmic: false, squares: reachByMagnitude[Math.max(1, mag)] ?? 3, widthSquares: 0, angle: 90 };
  }
  // Line extends to the battlefield edge; magnitude controls width.
  const widthByMagnitude = { 1: 1, 2: 3, 3: 5, 4: 7 };
  return { cataclysmic: false, squares: sceneEdgeSquares(), widthSquares: widthByMagnitude[Math.max(1, mag)] ?? 1, angle: 0 };
}

function waitCanvasClick(message) {
  return new Promise(resolve => {
    if (!canvas?.stage) return resolve(null);
    ui.notifications.info(message);
    const handler = event => {
      try {
        const global = event?.data?.global || event?.global || null;
        const local = global && canvas?.stage?.toLocal ? canvas.stage.toLocal(global) : global;
        resolve(local ? { x: local.x, y: local.y } : null);
      } catch {
        resolve(null);
      }
    };
    canvas.stage.once("pointerdown", handler);
  });
}

function directionDegrees(start, end) {
  return (Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI + 360) % 360;
}

async function createTemplate({ config, start, end, source, actor }) {
  const geo = geometryFor(config);
  const data = {
    t: config.shape,
    user: game.user.id,
    x: start.x,
    y: start.y,
    distance: geo.squares * gridDistance(),
    direction: end ? directionDegrees(start, end) : 0,
    angle: config.shape === "cone" ? geo.angle : 0,
    width: config.shape === "ray" ? geo.widthSquares * gridDistance() : 0,
    borderColor: "#00bfff",
    fillColor: "#00bfff",
    flags: {
      [MODULE_ID]: {
        areaAttack: true,
        version: VERSION,
        actorId: actor?.id || null,
        sourceKey: source?.key || null,
        sourceName: source?.name || null,
        shape: config.shape,
        magnitude: config.magnitude,
        magnitudeLabel: magnitudeLabel(config.magnitude),
        createdAt: Date.now()
      }
    }
  };
  const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [data]);
  const doc = created?.[0] || null;
  if (!doc) return null;
  await new Promise(r => setTimeout(r, 80));
  return {
    doc,
    object: canvas.templates?.get?.(doc.id)
      || canvas.templates?.placeables?.find?.(o => o.id === doc.id)
      || doc.object
      || null
  };
}

function tokenSamplePoints(token) {
  const d = token?.document || token;
  const size = gridSize();
  const w = Math.max(1, num(d?.width, 1));
  const h = Math.max(1, num(d?.height, 1));
  const x = num(d?.x, 0), y = num(d?.y, 0);
  const pts = [];
  // DBU 0.9.2: large characters are targeted if ANY occupied Square is inside.
  for (let ix = 0; ix < Math.ceil(w); ix++) {
    for (let iy = 0; iy < Math.ceil(h); iy++) {
      pts.push({ x: x + (ix + .5) * size, y: y + (iy + .5) * size });
    }
  }
  pts.push(tokenCenter(token));
  return pts;
}

function templateContains(templateObject, templateDoc, point) {
  try {
    const shape = templateObject?.shape;
    if (shape?.contains) return !!shape.contains(point.x - num(templateDoc.x, 0), point.y - num(templateDoc.y, 0));
  } catch {}
  if (String(templateDoc?.t) === "circle") {
    const radiusPx = num(templateDoc.distance, 0) / gridDistance() * gridSize();
    return Math.hypot(point.x - num(templateDoc.x, 0), point.y - num(templateDoc.y, 0)) <= radiusPx;
  }
  return false;
}

function sameSide(a, b) {
  const ad = num(a?.document?.disposition ?? a?.disposition, 0);
  const bd = num(b?.document?.disposition ?? b?.disposition, 0);
  return ad !== 0 && ad === bd;
}

function targetsInTemplate(template, attackerToken, config) {
  const out = [];
  for (const token of canvas?.tokens?.placeables || []) {
    if (!token?.actor) continue;
    if (token.id === attackerToken?.id) continue;
    if (config?.excludeAllies && sameSide(token, attackerToken)) continue;
    if (tokenSamplePoints(token).some(pt => templateContains(template.object, template.doc, pt))) out.push(token);
  }
  return out;
}

function allBattlefieldTargets(attackerToken, config) {
  return (canvas?.tokens?.placeables || []).filter(token => {
    if (!token?.actor || token.id === attackerToken?.id) return false;
    if (config?.excludeAllies && sameSide(token, attackerToken)) return false;
    return true;
  });
}

async function syncUserTargets(tokens) {
  try {
    for (const token of Array.from(game.user.targets || [])) {
      token.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true });
    }
    for (const token of tokens) {
      token.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
    }
  } catch (error) {
    console.warn("DBU Area | Não consegui sincronizar Targets visuais:", error);
  }
}

export async function resolveAreaTargets({ actor, attackerToken, source, existingTargets = [], config = null } = {}) {
  const cfg = normalizeAreaConfig(config || {}, source);
  if (!cfg.enabled) {
    return { isAoE: false, targets: Array.from(existingTargets || []), spec: cfg.autoSpec, config: cfg, template: null };
  }

  if (cfg.useSelected) {
    const targets = Array.from(existingTargets || game.user.targets || []);
    if (!targets.length) {
      ui.notifications.warn("Nenhum Target atual para este Area Attack.");
      return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };
    }
    return {
      isAoE: true,
      targets,
      spec: cfg.autoSpec,
      config: cfg,
      manualTargets: true,
      template: null,
      areaData: {
        shape: cfg.shape,
        magnitude: cfg.magnitude,
        magnitudeLabel: magnitudeLabel(cfg.magnitude),
        label: cfg.label,
        mode: cfg.mode,
        source: "current-targets",
        targetActorIds: targets.map(t => t.actor?.id).filter(Boolean)
      }
    };
  }

  const geo = geometryFor(cfg);
  if (geo.cataclysmic) {
    const targets = allBattlefieldTargets(attackerToken, cfg);
    await syncUserTargets(targets);
    if (!targets.length) {
      ui.notifications.warn(`${source?.name || "Area Attack"}: nenhum outro personagem no Battlefield.`);
      return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };
    }
    ui.notifications.info(`${source?.name || "Area Attack"}: Cataclysmic — ${targets.length} alvo(s) no Battlefield.`);
    return {
      isAoE: true,
      targets,
      spec: cfg.autoSpec,
      config: cfg,
      template: null,
      areaData: {
        shape: cfg.shape,
        magnitude: 5,
        magnitudeLabel: "Cataclysmic",
        label: cfg.label,
        mode: cfg.mode,
        cataclysmic: true,
        targetActorIds: targets.map(t => t.actor?.id).filter(Boolean)
      }
    };
  }

  // Sphere may be centered on the attacker or a chosen Target Square.
  // Cone and Line always start from the user's Square in the generic 0.9.2 rules.
  const forceAttackerOrigin = cfg.shape === "cone" || cfg.shape === "ray";
  const start = (forceAttackerOrigin || cfg.centeredOnAttacker)
    ? tokenCenter(attackerToken)
    : await waitCanvasClick(`DBU Area — clique na casa central de ${source?.name || "ataque"}.`);
  if (!start) return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };

  let end = null;
  if (cfg.shape === "cone" || cfg.shape === "ray") {
    end = await waitCanvasClick(`DBU Area — clique na direção de ${source?.name || "ataque"}.`);
    if (!end) return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };
  }

  let template = null;
  try {
    template = await createTemplate({ config: cfg, start, end, source, actor });
  } catch (error) {
    console.error("DBU Area | Criando template:", error);
    ui.notifications.error("Não foi possível criar o template de Area Attack. Verifique a permissão de Measured Templates.");
    return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };
  }
  if (!template) return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg };

  const targets = targetsInTemplate(template, attackerToken, cfg);
  await syncUserTargets(targets);

  if (!cfg.keep) {
    setTimeout(async () => {
      try { await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [template.doc.id]); } catch {}
    }, 1200);
  }

  if (!targets.length) {
    ui.notifications.warn(`${source?.name || "Area Attack"}: nenhum personagem detectado dentro da área.`);
    return { cancelled: true, isAoE: true, targets: [], spec: cfg.autoSpec, config: cfg, template };
  }

  ui.notifications.info(`${source?.name || "Area Attack"}: ${targets.length} alvo(s) detectado(s) automaticamente.`);
  return {
    isAoE: true,
    targets,
    spec: cfg.autoSpec,
    config: cfg,
    template,
    areaData: {
      shape: cfg.shape,
      magnitude: cfg.magnitude,
      magnitudeLabel: magnitudeLabel(cfg.magnitude),
      label: cfg.label,
      mode: cfg.mode,
      centeredOnAttacker: cfg.centeredOnAttacker,
      radiusOrReachSquares: geo.squares,
      widthSquares: geo.widthSquares,
      angle: geo.angle,
      targetActorIds: targets.map(t => t.actor?.id).filter(Boolean)
    }
  };
}

export const AreaAttack = {
  version: VERSION,
  magnitudes: MAGNITUDES,
  getAreaSpec,
  normalizeAreaConfig,
  magnitudeLabel,
  resolveAreaTargets
};
