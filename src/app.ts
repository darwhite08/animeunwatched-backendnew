import express from "express";
import cors from "cors";
import animeRoutes from "./routes/anime.routes";
import { errorHandler } from "./middlewares/error.middleware";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/anime", animeRoutes);

app.use(errorHandler);

export default app;