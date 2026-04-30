export function routeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

export function rerunResponseError(error, fallbackCode = "invalid_state") {
  return {
    requested: true,
    started: false,
    error: {
      code: error?.code || fallbackCode,
      message: error?.message || "rerun failed",
    },
  };
}
