import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nexoraRouter from "./nexora";
import administrationRouter from "./administration";

const router: IRouter = Router();

router.use(healthRouter);
router.use(nexoraRouter);
router.use(administrationRouter);

export default router;
