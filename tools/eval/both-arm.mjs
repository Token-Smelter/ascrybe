export function createBothArm({ filesystem, graph }) {
  if (!filesystem?.schema || !filesystem?.tools || !graph?.schema || !graph?.tools) {
    throw new Error('both arm requires existing filesystem and graph arms');
  }
  const overlaps = Object.keys(filesystem.tools).filter(name => Object.hasOwn(graph.tools, name));
  if (overlaps.length) throw new Error(`both arm tool names overlap: ${overlaps.join(', ')}`);
  const allowed_tool_names = [...filesystem.schema.allowed_tool_names, ...graph.schema.allowed_tool_names];
  return Object.freeze({
    schema: Object.freeze({
      version: 'evaluation-both-arm/v1',
      allowed_tool_names,
      // This is a literal schema union. No tool beyond the pre-existing bounded arm surfaces is
      // introduced by the additive treatment.
      tools: [...filesystem.schema.tools, ...graph.schema.tools],
    }),
    tools: Object.freeze({ ...filesystem.tools, ...graph.tools }),
  });
}
