export function createAppStatusApi(request) {
  return {
    getHealth: () => request("GET", "/health"),
    getServiceStatus: () => request("GET", "/services/status"),
  };
}
