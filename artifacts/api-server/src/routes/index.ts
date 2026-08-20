import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nexoraRouter from "./nexora";

const router: IRouter = Router();

router.use(healthRouter);
router.use(nexoraRouter);

export default router;
