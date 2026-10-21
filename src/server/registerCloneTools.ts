import type { Logger } from "pino";

import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  cloneLocalApplicationValidated,
  currentLocalApplicationHost,
  findLocalApplicationsValidated,
} from "../application/localApplications/LocalApplicationService.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import {
  cloneWebsiteValidated,
  exportWebMirrorValidated,
} from "../application/WebMirrorService.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { toolContract } from "../contracts/toolContracts.js";
import { err } from "../domain/result.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import { deliverEvidenceResult } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

interface CloneToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
  readonly artifactResources: ArtifactResourceScope;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly browser: BrowserScenarioCapturePort | undefined;
  readonly browserLoadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Register website mirror/clone and local application tools. */
export const registerCloneTools = (
  server: EvidenceMcpServer,
  options: CloneToolRegistration,
): void => {
  const run = <Input>(
    name: Parameters<typeof toolContract>[0],
    operation: (
      input: Input,
      signal: AbortSignal,
    ) => ReturnType<typeof exportWebMirrorValidated>,
  ) => {
    const contract = toolContract(name);
    return (input: Input, context: { mcpReq: { signal: AbortSignal } }) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () =>
          deliverEvidenceResult(
            server,
            await logToolExecution(options.logger, contract.name, () =>
              operation(input, context.mcpReq.signal),
            ),
            contract,
            options.recordEvidence,
          ),
      );
  };

  const mirror = toolContract("export_web_mirror");
  server.registerTool(
    mirror.name,
    toolRegistrationOptions(mirror),
    run(
      mirror.name,
      (input: Parameters<typeof exportWebMirrorValidated>[0], signal) =>
        exportWebMirrorValidated(input, options.artifactResources, { signal }),
    ),
  );

  const clone = toolContract("clone_website");
  const cloneHandler = run(
    clone.name,
    (input: Parameters<typeof cloneWebsiteValidated>[0], signal) =>
      cloneWebsiteValidated(
        input,
        {
          browser: options.browser,
          resources: options.artifactResources,
          environment: options.environment,
        },
        { signal },
      ),
  );
  server.registerTool(
    clone.name,
    toolRegistrationOptions(clone),
    async (input, context) =>
      options.browserLoadFailure === undefined
        ? cloneHandler(input, context)
        : server.delivery.toCallToolResult(
            err(
              optionalProviderUnavailable(
                options.browserLoadFailure,
                clone.name,
              ),
            ),
            clone,
          ),
  );

  const find = toolContract("find_local_applications");
  server.registerTool(
    find.name,
    toolRegistrationOptions(find),
    run(
      find.name,
      (input: Parameters<typeof findLocalApplicationsValidated>[0], signal) =>
        findLocalApplicationsValidated(
          input,
          currentLocalApplicationHost(options.environment),
          { signal },
        ),
    ),
  );

  const copy = toolContract("clone_local_application");
  server.registerTool(
    copy.name,
    toolRegistrationOptions(copy),
    run(
      copy.name,
      (input: Parameters<typeof cloneLocalApplicationValidated>[0], signal) =>
        cloneLocalApplicationValidated(
          input,
          {
            host: currentLocalApplicationHost(options.environment),
            resources: options.artifactResources,
          },
          { signal },
        ),
    ),
  );
};
