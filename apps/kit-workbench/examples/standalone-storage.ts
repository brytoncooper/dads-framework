import { createObjectStorage } from "@dads-framework/object-storage";

const storage = createObjectStorage({ driver: "memory" });
await storage.put("notes/hello.txt", "Hello from Dads", "text/plain");
const note = await storage.get("notes/hello.txt");
if (note) process.stdout.write(new TextDecoder().decode(note.body) + "\n");
