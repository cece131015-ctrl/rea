import { z } from "zod";
import { containingProcedureResolutionSchema } from "../hopperValues.js";
import { nativeCallGraphSchema } from "./nativeCallGraph.js";

export const NATIVE_PRIMITIVE_OBSERVATION_OPERATIONS = [
  "procedure_address",
  "procedure_callees",
  "procedure_callers",
  "resolve_containing_procedure",
] as const;
export const NATIVE_OBSERVATION_OPERATIONS = [
  ...NATIVE_PRIMITIVE_OBSERVATION_OPERATIONS,
  "get_call_graph",
] as const;
export type NativeObservationOperation =
  (typeof NATIVE_OBSERVATION_OPERATIONS)[number];
export const nativeAddressListSchema = z.array(z.string());
export const nativeObservationSourceSchemas = {
  procedure_address: z.string(),
  procedure_callees: nativeAddressListSchema,
  procedure_callers: nativeAddressListSchema,
  resolve_containing_procedure: containingProcedureResolutionSchema,
  get_call_graph: nativeCallGraphSchema,
};
export type NativeObservation = {
  [Operation in NativeObservationOperation]: {
    operation: Operation;
    result: z.output<(typeof nativeObservationSourceSchemas)[Operation]>;
  };
}[NativeObservationOperation];

/** One operation family shared by view projection and response-budget recovery. */
export const isNativeObservationOperation = (
  operation: string,
): operation is NativeObservationOperation =>
  NATIVE_OBSERVATION_OPERATIONS.some((supported) => supported === operation);
