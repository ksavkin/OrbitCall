import { httpRouter } from "convex/server";
import { phrase } from "./call/ingest";

const http = httpRouter();

// Translation worker callback: one phrase (original, translations, protected values, per-language status), service
// credential only (header x-call-service-token = CALL_SERVICE_TOKEN). Spec §5 step 5: captions come from Convex.
http.route({ path: "/call/phrase", method: "POST", handler: phrase });

export default http;
