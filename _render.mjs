function pad(text, width) { return text + ' '.repeat(Math.max(0, width - text.length)); }
function table(rows, header) {
  const all = header ? [header, ...rows] : rows;
  const columns = Math.max(...all.map(r => r.length));
  const widths = [];
  for (let i = 0; i < columns; i++) widths[i] = Math.max(...all.map(r => (r[i] ?? '').length));
  const render = (row) => row.map((c, i) => pad(c ?? '', widths[i])).join('  ').replace(/\s+$/,'');
  const lines = [];
  if (header) lines.push(render(header));
  for (const r of rows) lines.push(render(r));
  return lines.join('\n');
}

function requiring(p) { return { acceptance:false, gate:null, checklist:[], fields:[], sections:[], dependencies:false, ...p }; }
const GUARDS = {
  specced: { requires: requiring({ sections: ['Problem','Acceptance criteria'] }) },
  ready: { requires: requiring({ sections: ['Plan'] }) },
  in_progress: { requires: requiring({ dependencies: true }) },
  in_review: { requires: requiring({ gate: 'default' }), message: 'cannot go to review — the gate is not green' },
};
function arrows(from, targets) {
  return targets.map(to => {
    const g = GUARDS[to];
    if (!g) return { from, to, requires: requiring({}) };
    return { from, to, requires: g.requires, message: g.message };
  });
}
const transitions = [
  ...arrows('backlog', ['specced','ready','blocked','cancelled']),
  ...arrows('specced', ['ready','backlog','blocked','cancelled']),
  ...arrows('ready', ['in_progress','specced','backlog','blocked','cancelled']),
  ...arrows('in_progress', ['in_review','ready','blocked','cancelled']),
  ...arrows('in_review', ['done','in_progress','blocked','cancelled']),
  ...arrows('done', ['in_progress']),
  ...arrows('blocked', ['backlog','specced','ready','in_progress','in_review','cancelled']),
  ...arrows('cancelled', ['backlog']),
];

function hasRequirements(r) {
  return r.acceptance || r.gate !== null || r.checklist.length>0 || r.fields.length>0 || r.sections.length>0 || r.dependencies;
}
function describeRequirements(r) {
  if (!hasRequirements(r)) return '';
  const parts = [];
  if (r.acceptance) parts.push('acceptance');
  if (r.gate) parts.push(`gate \`${r.gate}\``);
  if (r.checklist.length>0) parts.push(`checklist: ${r.checklist.map(e=>e.label).join(', ')}`);
  if (r.fields.length>0) parts.push(`fields: ${r.fields.join(', ')}`);
  if (r.sections.length>0) parts.push(`sections: ${r.sections.join(', ')}`);
  if (r.dependencies) parts.push('dependencies');
  return parts.join(', ');
}

console.log(table(transitions.map(t => [`${t.from} → ${t.to}`, describeRequirements(t.requires)]), ['ARROW','REQUIRES']));
