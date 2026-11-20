import { z } from "zod";
import { migrate } from "./migrations.js";

await migrate(z.url().parse(process.env["DATABASE_URL"]));
