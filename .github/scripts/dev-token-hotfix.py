#!/usr/bin/env python3
"""Migrate complete packaged DEV Intervene/Reflect logic to token identities."""
from pathlib import Path

path = Path("/tmp/dbu-dev-package/scripts/intervene.js")
s = path.read_text(encoding="utf-8")

def swap(old, new, expected=1):
    global s
    count = s.count(old)
    if count != expected:
        raise SystemExit("Intervene migration: expected %d, saw %d: %r" % (expected, count, old[:80]))
    s = s.replace(old, new)

swap('import { areAllies as areTeamAllies } from "./combat-teams.js";',
     'import { areAllies as areTeamAllies } from "./combat-teams.js";\n'
     'import { tokenForActor, participantReference, resolveParticipant, '
     'participantKeyForAttack, attackTargetKeys } from "./core/token-identity.js";')

a = s.index("function eligibleInterveners(message, targetActor) {")
b = s.index("\nfunction currentRound(", a)
s = s[:a] + """function eligibleInterveners(message, targetActor) {
  const attack = attackData(message);
  if (!attack || !targetActor) return [];
  const targetToken = tokenForActor(targetActor, { preferControlled: false });
  const targetKey = participantKeyForAttack(targetActor, attack);
  const attacked = new Set(attackTargetKeys(attack));
  const attackerKey = attack.attackerRef?.key || attack.attackerId;
  return Array.from(canvas?.tokens?.placeables || [])
    .map(token => ({ actor: token.actor, token }))
    .filter(({ actor, token }) => {
      if (!actor || actor.type !== "character") return false;
      if (!game.user.isGM && !actor.isOwner) return false;
      const key = participantReference(actor, token).key;
      if (!key || key === targetKey || key === attackerKey || attacked.has(key)) return false;
      if (!attack.attackerRef && actor.id === attack.attackerId) return false;
      if (!targetToken || !sameSide(token, targetToken)) return false;
      const distance = tokenDistanceSquares(token, targetToken);
      return !Number.isFinite(distance) || distance <= 8.001;
    })
    .map(({ actor, token }) => ({ actor, token, distance: tokenDistanceSquares(token, targetToken) }));
}
""" + s[b:]

swap('function getTokenForActor(actorId) {\n  return canvas?.tokens?.placeables?.find(token => token.actor?.id === actorId) || null;\n}',
     'function getTokenForActor(actorOrKey) {\n'
     '  const actor = typeof actorOrKey === "object" ? actorOrKey : resolveParticipant(actorOrKey);\n'
     '  return tokenForActor(actor, { preferControlled: false });\n}')
swap('const token = getTokenForActor(actor.id);','const token = getTokenForActor(actor);')
swap('const options = candidates.map(({ actor, distance }) => {',
     'const options = candidates.map(({ actor, token, distance }) => {')
d = chr(36)
swap('const options = targets.map(({ actor }) =>',
     'const options = targets.map(({ actor, token }) =>')
swap('value="' + d + '{actor.id}"',
     'value="' + d + '{participantReference(actor, token).key}"', 2)

swap('const target = game.actors.get(targetId);',
     'const target = resolveParticipant(targetId, attackData(message));', 4)
swap('const target = game.actors.get(data.targetId);',
     'const target = resolveParticipant(data.targetId, attackData(message));')
swap('const intervener = game.actors.get(choice.actorId);',
     'const intervener = resolveParticipant(choice.actorId, attack);')
swap('const intervener = game.actors.get(data.intervenerId);',
     'const intervener = resolveParticipant(data.intervenerId, attack);')
swap('const intervener = game.actors.get(resolution.intervenerId);',
     'const intervener = resolveParticipant(resolution.intervenerId, attack);', 2)
swap('const reflector = game.actors.get(reflectorId);',
     'const reflector = typeof reflectorId === "object" ? reflectorId : resolveParticipant(reflectorId, attack);')
swap('const attacker = game.actors.get(attack.attackerId);',
     'const attacker = resolveParticipant(attack.attackerRef?.key || attack.attackerId, attack);', 1)
swap('attacker: game.actors.get(attack.attackerId)',
     'attacker: resolveParticipant(attack.attackerRef?.key || attack.attackerId, attack)')
swap('await startReflect(message, intervener.id);',
     'await startReflect(message, intervener);')

swap('const valid = eligibleInterveners(message, target).some(entry => entry.actor.id === intervener.id);',
     'const valid = eligibleInterveners(message, target).some(entry => participantReference(entry.actor, entry.token).key === choice.actorId);')
swap('intervenerId: intervener.id,\n    option: choice.option,',
     'intervenerId: choice.actorId,\n    option: choice.option,')
swap('if ((attack.targetActorIds || []).includes(intervener.id)) return;',
     'if (attackTargetKeys(attack).includes(data.intervenerId)) return;')
swap('if (intervener.id === target.id || intervener.id === attack.attackerId) return;',
     'if (data.intervenerId === data.targetId || data.intervenerId === (attack.attackerRef?.key || attack.attackerId)) return;')
swap('intervenerId: intervener.id,\n      intervenerName:',
     'intervenerId: data.intervenerId,\n      intervenerName:')

swap('function reflectTargetRow(target) {\n  const safeId = String(target.id)',
     'function reflectTargetRow(target) {\n  const targetKey = participantReference(target).key;\n  const safeId = String(targetKey)')
swap('data-defender-id="' + d + '{target.id}"',
     'data-defender-id="' + d + '{targetKey}"', 6)
swap('    targetActorIds: [target.id]',
     '    attackerRef: participantReference(reflector),\n'
     '    targetRefs: [participantReference(target)],\n'
     '    targetActorIds: [target.id]')
swap('    [target.id]: { resolved: false, pending: false }',
     '    [participantReference(target).key]: { resolved: false, pending: false }')

path.write_text(s, encoding="utf-8")
print("Intervene/Reflect token-first migration: OK")
