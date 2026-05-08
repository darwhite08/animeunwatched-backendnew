import { env } from "../../config/env";
import { JikanProvider } from "./jikan.provider";

export const catalog =
  env.CATALOG_PROVIDER === "jikan"
    ? new JikanProvider()
    : new JikanProvider(); // placeholder: expand when mal/anilist providers are added
