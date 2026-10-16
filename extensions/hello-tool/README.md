# hello-tool (sample plugin)

The smallest useful ClawNexus plugin: two tools, no permissions.

```
clawnexus plugins install extensions/hello-tool
clawnexus plugins info hello-tool        # read what it may do
clawnexus plugins enable hello-tool --yes
```

Then the tools `hello-tool.greet` and `hello-tool.add` appear in `clawnexus tool list`, and the model can use them like any other tool, under the same policy.

Rules a plugin lives by (see docs/04):
- It runs in its own process. It can read only its own folder; it can write only its data folder, and only if the manifest asks for `"fs": ["data"]`; it can start programs only if the manifest asks for `"exec": true`.
- Network use is declared in the manifest, but the system cannot enforce it yet. The owner is told so.
- Its tools get a risk class no lower than its permissions imply, and what they return is treated as untrusted.
- Changing even one byte of the plugin means the owner has to approve it again.
