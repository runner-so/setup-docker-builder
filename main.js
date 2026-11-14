// runner-so/setup-docker-builder (RUN-513, ADR 0046 §5): BuildKit on a
// local unix socket, its state on the Docker layer cache's sticky disk, as
// the current buildx builder and the job's BUILDX_BUILDER, so docker build, docker/build-push-action and
// bake all use it. post.js reports the job's builds and stops buildkitd.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync, spawn } = require("node:child_process")
const { SOCKET, ROOT, BUILDER, diskKey, buildkitdConfig, jobEnv, guestd } = require("./lib.js")

const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString()
const append = (file, line) => file && fs.appendFileSync(file, line + "\n")

async function main() {
  const cacheKey = (process.env["INPUT_CACHE-KEY"] ?? "").trim()
  const key = diskKey(cacheKey)
  const started = Date.now()

  const q = new URLSearchParams({ key, path: ROOT })
  const m = await guestd(`/mount?${q}`, undefined, 3_600_000)
  if (m.code === 200) {
    console.log(`Docker layer cache ${cacheKey} mounted at ${ROOT}`)
  } else {
    // A build without its cache is slower, not wrong.
    console.log(`::warning title=Docker layer cache::${cacheKey}: ${m.text || m.code}; building without the cache`)
    run("sudo", "-n", "install", "-d", ROOT)
  }

  const tmp = process.env.RUNNER_TEMP || "/tmp"
  const config = path.join(tmp, "buildkitd.toml")
  fs.writeFileSync(config, buildkitdConfig(ROOT))
  run("sudo", "-n", "install", "-d", path.dirname(SOCKET))
  const log = fs.openSync(path.join(tmp, "buildkitd.log"), "a")
  // Before buildkitd starts, so the post step stops it even if a later
  // step here fails.
  append(process.env.GITHUB_STATE, `started=${started}`)
  append(process.env.GITHUB_STATE, `cacheKey=${cacheKey}`)
  spawn("sudo", ["-n", "buildkitd", "--config", config, "--group", "docker"], { detached: true, stdio: ["ignore", log, log] }).unref()

  for (let i = 0; ; i++) {
    try {
      run("buildctl", "--addr", `unix://${SOCKET}`, "debug", "workers")
      break
    } catch (e) {
      if (i >= 60) throw new Error(`buildkitd did not start in 30 s: ${fs.readFileSync(path.join(tmp, "buildkitd.log"), "utf8").slice(-2000)}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  run("docker", "buildx", "create", "--name", BUILDER, "--driver", "remote", "--driver-opt", "default-load=true", `unix://${SOCKET}`, "--use")
  run("docker", "buildx", "inspect", "--bootstrap", BUILDER)

  for (const line of jobEnv()) append(process.env.GITHUB_ENV, line)
  append(process.env.GITHUB_OUTPUT, `name=${BUILDER}`)
  console.log(`Docker builder ${BUILDER} ready on ${SOCKET}`)
}

main().catch((e) => {
  console.log(`::error title=Docker builder::${e.message}`)
  process.exitCode = 1
})
