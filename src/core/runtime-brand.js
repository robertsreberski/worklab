export const WORKLAB_RUNTIME_BRAND = Object.freeze({
  schemaPrefix: "worklab",
  mcpClientName: "worklab",
  mcpClientVersion: "0.1.0",
  tempdirPrefix: "worklab-cli-",
  providerModelPrefix: "worklab",
  doctorCommand: "worklab doctor",
  serviceName: "worklab",
  clientInfoName: "worklab",
  clientInfoTitle: "Worklab",
});

export function withWorklabRuntimeBrand(options = {}) {
  return {
    ...options,
    runtimeBrand: options.runtimeBrand || WORKLAB_RUNTIME_BRAND,
  };
}
