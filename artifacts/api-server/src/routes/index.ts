import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import organizationsRouter from "./organizations";
import usersRouter from "./users";
import nexoraRouter from "./nexora";
import administrationRouter from "./administration";
import telemetryRouter from "./telemetry";
import alertsRouter from "./alerts";
import notificationsRouter from "./notifications";
import softwareRouter from "./software";
import inventoryRouter from "./inventory";
import securityRouter from "./security";
import remoteCommandsRouter from "./remote-commands";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(organizationsRouter);
router.use(usersRouter);
router.use(telemetryRouter);
router.use(alertsRouter);
router.use(notificationsRouter);
router.use(softwareRouter);
router.use(inventoryRouter);
router.use(securityRouter);
router.use(remoteCommandsRouter);
router.use(nexoraRouter);
router.use(administrationRouter);

export default router;
