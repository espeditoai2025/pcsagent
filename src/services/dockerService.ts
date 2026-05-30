import Docker from "dockerode";
import * as path from "path";
import * as fs from "fs/promises";
import crypto from "crypto";

const docker = new Docker(); // Connette alla socket Docker locale

export interface ExecutePythonResult {
  success: boolean;
  output: string;
  error: string | null;
}

export interface ExecuteOptions {
  /** Variabili d'ambiente extra iniettate nel container (es. token, config). */
  env?: Record<string, string>;
  /** Workspace isolato (di norma userId): i file vivono in shared_data/<workspace>. */
  workspace?: string;
}

// --- Coda / limite di concorrenza (il VPS ha 1 vCPU: evita la saturazione) ---
const MAX_CONCURRENT = 2;
let running = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve)).then(() => {
    running += 1;
  });
}
function release(): void {
  running -= 1;
  const next = waiters.shift();
  if (next) next();
}

/** Sanifica il workspace per usarlo come nome cartella (no path traversal). */
export function safeWorkspace(ws?: string): string {
  if (!ws) return "";
  return ws.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

/**
 * Esegue codice Python in un container Docker isolato (immagine pcsai-python).
 * I file generati vivono in shared_data/<workspace> (isolamento per-utente).
 * Concorrenza limitata e RAM cap 512MB per reggere più utenti sul VPS.
 */
export async function executePythonScript(code: string, opts: ExecuteOptions = {}): Promise<ExecutePythonResult> {
  await acquire();
  const containerName = `agent-exec-${crypto.randomBytes(4).toString("hex")}`;
  const baseDir = path.resolve(process.cwd(), "shared_data");
  const ws = safeWorkspace(opts.workspace);
  const dataDir = ws ? path.join(baseDir, ws) : baseDir;
  const envList = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v ?? ""}`);

  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});

  const scriptFileName = `script_${crypto.randomBytes(4).toString("hex")}.py`;
  await fs.writeFile(path.join(dataDir, scriptFileName), code, "utf8");

  let container: any = null;
  try {
    console.log(`Starting execution in container: ${containerName} (ws: ${ws || "-"})`);
    container = await docker.createContainer({
      Image: "pcsai-python:latest",
      name: containerName,
      Cmd: ["python", `/app/data/${scriptFileName}`],
      WorkingDir: "/app/data",
      Env: envList,
      Tty: true,
      HostConfig: {
        AutoRemove: false,
        Binds: [`${dataDir}:/app/data`],
        NetworkMode: "bridge",
        Memory: 512 * 1024 * 1024, // 512MB
      },
    });

    await container.start();

    const timeout = 300000; // 5 minuti
    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout Execution Exceeded (5m)")), timeout);
    });

    const result = await Promise.race([waitPromise, timeoutPromise]);

    const logs = await container.logs({ stdout: true, stderr: true, follow: false });
    const outputString = logs.toString("utf8");

    await container.remove({ force: true }).catch(() => {});

    if (result.StatusCode === 0) {
      return { success: true, output: outputString, error: null };
    }
    return { success: false, output: outputString, error: `Exit Code ${result.StatusCode}:\n${outputString}` };
  } catch (error: any) {
    if (container) await container.remove({ force: true }).catch(() => {});
    return { success: false, output: "", error: error.message };
  } finally {
    release();
  }
}
