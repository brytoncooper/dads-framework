import { startTelemetry } from "@dads-framework/telemetry";
import { readEnvironment } from "./config.js";
import { developmentMail } from "./dev-mail.js";
import { readEnterpriseConfiguration } from "./enterprise-config.js";
import { readFeaturePreview } from "./feature-previews.js";

const environment = readEnvironment(process.env);
const enterprise = readEnterpriseConfiguration(process.env);
const featurePreview = readFeaturePreview(process.env);
const logMail = environment.DADS_DEV_LOG_MAIL === "1";
if (
  logMail &&
  (environment.NODE_ENV === "production" || environment.HOST !== "127.0.0.1")
) {
  throw new Error(
    "Local mail logging requires a development server on 127.0.0.1.",
  );
}

const telemetry = await startTelemetry({
  serviceName: `dads-${environment.DADS_API}`,
});
const { startApp } = await import("./start-app.js");
try {
  const app = await startApp(
    environment.DADS_API,
    {
      databaseUrl: environment.DATABASE_URL,
      baseUrl: environment.baseUrl,
      secret: environment.DADS_IDENTITY_SECRET,
      enterprise,
      ...(featurePreview === undefined ? {} : { featurePreview }),
      preparePermissionChecks:
        environment.DADS_PREPARE_PERMISSION_CHECKS === "1",
      fileStorageDirectory: environment.DADS_FILE_STORAGE_DIR,
      ...(logMail || environment.NODE_ENV === "production"
        ? { enqueueEmail: developmentMail(logMail) }
        : { mailSpoolDirectory: environment.DADS_MAIL_SPOOL_DIR }),
    },
    telemetry,
  );
  try {
    await app.listen({ host: environment.HOST, port: environment.PORT });
  } catch (fault) {
    await app.close();
    throw fault;
  }
  const close = (): void => {
    void app
      .close()
      .finally(() => telemetry?.shutdown())
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (fault) {
  await telemetry?.shutdown();
  throw fault;
}
