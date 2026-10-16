// Throwaway "plugin" running in a child process; echoes calls and can crash on demand.
process.on("message", (m) => {
  if (m.op === "echo") process.send({ id: m.id, v: m.v });
  if (m.op === "crash") throw new Error("plugin crashed on purpose");
});
process.send({ ready: true });
