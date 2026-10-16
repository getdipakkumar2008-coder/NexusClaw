// Sample plugin: two harmless tools. It asks for no permissions, so it cannot touch files, start programs or use secrets.
//
// A plugin runs in its own process and can read nothing outside its own folder, so it must not import packages from
// elsewhere. Use the SDK for editor types only (the JSDoc line below) or bundle what you need into this folder.

/** @type {import("@clawnexus/plugin-sdk").PluginDefinition} */
export default {
  setup(ctx) {
    ctx.registerTool({
      name: "greet",
      description: "Greet someone by name.",
      args: { name: { type: "string", maxLength: 40, description: "Who to greet" } },
      run: ({ name }) => `Hello, ${name}!`,
    });
    ctx.registerTool({
      name: "add",
      description: "Add two numbers.",
      args: { a: { type: "number" }, b: { type: "number" } },
      run: ({ a, b }) => ({ sum: a + b }),
    });
    ctx.log("info", "hello-tool is ready");
  },
};
