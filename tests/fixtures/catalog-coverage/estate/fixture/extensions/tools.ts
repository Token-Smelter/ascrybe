// Exposes a stable agent affordance.
// Keep this registration literal.
export const tools = {
  register() {
    pi.registerTool({
      name: 'declare_ward',
      description: 'Declare a ward',
      parameters: Type.Object({ target: Type.String() }),
    });
    pi.registerTool({
      name: `remove_${suffix}`,
    });
  },
};
