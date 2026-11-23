import { createSocket, type Socket } from "node:dgram";
import { getServers, setServers } from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const loopback = "127.0.0.1";
const headerBytes = 12;
const txtIn = Buffer.from([0, 16, 0, 1]);

/** Exercise actual TXT lookups from installed packages, including packed consumers. */
export async function withDnsTxtRecord<Result>(
  { name, value }: { name: string; value: string },
  run: () => Promise<Result>,
): Promise<Result> {
  const question = encodeQuestion(name);
  const answer = encodeAnswer(value);
  const socket = createSocket("udp4");
  socket.on("message", (query, remote) => {
    if (!query.subarray(headerBytes, headerBytes + question.length).equals(question)) return;
    const header = Buffer.alloc(headerBytes);
    query.copy(header, 0, 0, 2); // Transaction ID.
    header.writeUInt16BE(0x8180, 2); // Successful response to a recursive query.
    header.writeUInt16BE(1, 4); // One question.
    header.writeUInt16BE(1, 6); // One answer.
    socket.send([header, question, answer], remote.port, remote.address);
  });

  const previousServers = getServers();
  try {
    await listen(socket);
    // setServers replaces the default resolver. Refresh resolved ESM imports
    // so packages that imported resolveTxt before the fixture use that resolver.
    replaceServers([`${loopback}:${String(socket.address().port)}`]);
    return await run();
  } finally {
    try {
      replaceServers(previousServers);
    } finally {
      await new Promise<void>((resolve) => socket.close(resolve));
    }
  }
}

function listen(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, loopback, () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function encodeQuestion(name: string): Buffer {
  const labels = name.split(".").map((label) => Buffer.from(label, "ascii"));
  return Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), label])),
    Buffer.from([0]),
    txtIn,
  ]);
}

function encodeAnswer(text: string): Buffer {
  const value = Buffer.from(text, "utf8");
  if (value.length > 255) throw new Error("The fixture TXT record is too long.");
  const data = Buffer.concat([Buffer.from([value.length]), value]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([
    Buffer.from([0xc0, headerBytes]), // Owner name points to the question.
    txtIn,
    Buffer.alloc(4), // Zero TTL.
    length,
    data,
  ]);
}

function replaceServers(servers: string[]): void {
  setServers(servers);
  syncBuiltinESMExports();
}
