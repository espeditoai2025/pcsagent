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
 * Esegue codice Python in un container Docker isolato.
 * Il container può accedere alla rete per scaricare pacchetti (pip install) se necessario,
 * ed espone un volume condiviso montato in /app/data per leggere/scrivere file.
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

  try {
    // Controlla e scarica l'immagine se necessario
    await new Promise<void>((resolve, reject) => {
      docker.pull("python:3.11-slim", (err: any, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, onFinished, onProgress);
        function onFinished(err: any, output: any) {
          if (err) return reject(err);
          resolve();
        }
        function onProgress(event: any) {}
      });
    });

    console.log(`Starting execution in container: ${containerName}`);
    
    const container = await docker.createContainer({
      Image: "python:3.11-slim",
      name: containerName,
      Cmd: ["python", `/app/data/${scriptFileName}`],
      WorkingDir: "/app/data",
      Tty: true,
      HostConfig: {
        AutoRemove: true,
        Binds: [`${sharedDataDir}:/app/data`],
        // Rete abilitata per permettere al container di scaricare librerie 
        NetworkMode: "bridge",
        // Limiti di risorse (opzionale, ma consigliato)
        Memory: 1024 * 1024 * 1024, // 1GB
      },
    });

    await container.start();

    // Timeout di 10 minuti (600.000 ms)
    const timeout = 600000;
    
    // Attendi la terminazione o il timeout
    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout Execution Exceeded (10m)")), timeout);
    });

    const result = await Promise.race([waitPromise, timeoutPromise]);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
    });

    const outputString = logs.toString("utf8");

    // Pulizia file script (opzionale, se vogliamo mantenere un log possiamo evitarlo)
    // await fs.unlink(scriptHostPath).catch(() => {});

    if (result.StatusCode === 0) {
      return { success: true, output: outputString, error: null };
    } else {
      return { success: false, output: outputString, error: `Exit Code ${result.StatusCode}:\n${outputString}` };
    }
  } catch (error: any) {
    return { success: false, output: "", error: error.message };
  }
}
