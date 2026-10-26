import { parseAnalysisInput } from "./AnalysisInput.js";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import { nativeProcedureInputSchema } from "../domain/native/nativeProcedureInput.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createEvidence } from "../domain/evidence.js";
import { parseFunctionDossier } from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";

/**
 * Preserve the provider's observations when presenting a validated function
 * dossier. Parameters are the provider input only: adapters separate delivery
 * options such as MCP detail before calling.
 */
export const executeFunctionAnalysisEvidence = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget | undefined,
  options?: ExecutionOptions,
) => {
  const input = parseAnalysisInput(
    "analyze_function",
    parameters,
    nativeProcedureInputSchema,
    options?.signal,
  );
  if (!input.ok) return input;
  const arguments_ = input.value;
  const execution = await analysis.execute(
    "analyze_function",
    arguments_,
    options,
  );
  if (!execution.ok) return execution;
  const dossier = parseFunctionDossier(execution.value.result);
  if (!dossier.ok) return dossier;
  const observation = execution.value;
  return completeProviderEvidence(
    createEvidence(
      observation.subject === undefined
        ? target
        : (observation.subject ?? undefined),
      observation.provider,
      {
        operation: "analyze_function",
        parameters: arguments_,
        result: dossier.value,
        rawResult: observation.rawResult,
        limitations: observation.limitations,
        locations: observation.locations,
        ...(observation.relationshipCoverage === undefined
          ? {}
          : { relationshipCoverage: observation.relationshipCoverage }),
        ...(observation.analysisProfile === undefined
          ? {}
          : { analysisProfile: observation.analysisProfile }),
      },
    ),
    options?.signal,
  );
};
