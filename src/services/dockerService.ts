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

/**
 * Esegue codice Python in un container Docker isolato usando l'immagine pcsai-python
 * che ha già pre-installate tutte le librerie comuni (pandas, numpy, reportlab, ecc.).
 * Il container ha accesso alla rete ed espone un volume condiviso in /app/data.
 */
export async function executePythonScript(code: string): Promise<ExecutePythonResult> {
  const containerName = `agent-exec-${crypto.randomBytes(4).toString("hex")}`;
  const sharedDataDir = path.resolve(process.cwd(), "shared_data");

  // Assicurati che la cartella condivisa esista
  await fs.mkdir(sharedDataDir, { recursive: true }).catch(() => {});

  const scriptFileName = `script_${crypto.randomBytes(4).toString("hex")}.py`;
  const scriptHostPath = path.join(sharedDataDir, scriptFileName);

  // Salva il codice Python in un file nel volume condiviso
  await fs.writeFile(scriptHostPath, code, "utf8");

  let container: any = null;

  try {
    console.log(`Starting execution in container: ${containerName}`);

    // Usa pcsai-python:latest che ha già tutte le librerie pre-installate
    container = await docker.createContainer({
      Image: "pcsai-python:latest",
      name: containerName,
      Cmd: ["python", `/app/data/${scriptFileName}`],
      WorkingDir: "/app/data",
      Tty: true,
      HostConfig: {
        // AutoRemove: false — lo rimuoviamo manualmente DOPO aver letto i log
        AutoRemove: false,
        Binds: [`${sharedDataDir}:/app/data`],
        NetworkMode: "bridge",
        Memory: 1024 * 1024 * 1024, // 1GB
      },
    });

    await container.start();

    // Timeout di 5 minuti
    const timeout = 300000;

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout Execution Exceeded (5m)")), timeout);
    });

    const result = await Promise.race([waitPromise, timeoutPromise]);

    // Leggi i log PRIMA di rimuovere il container
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    const outputString = logs.toString("utf8");

    // Rimozione manuale del container
    await container.remove({ force: true }).catch(() => {});

    if (result.StatusCode === 0) {
      return { success: true, output: outputString, error: null };
    } else {
      return { success: false, output: outputString, error: `Exit Code ${result.StatusCode}:\n${outputString}` };
    }
  } catch (error: any) {
    // Tenta comunque di rimuovere il container in caso di errore
    if (container) {
      await container.remove({ force: true }).catch(() => {});
    }
    return { success: false, output: "", error: error.message };
  }
}
