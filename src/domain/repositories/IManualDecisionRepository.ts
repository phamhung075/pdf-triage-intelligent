import { ManualDecisionRecord } from '../../infrastructure/manual-decisions-store.js';

export interface IManualDecisionRepository {
  recordDecision(decision: ManualDecisionRecord): Promise<void>;
  getDecisions(): Promise<ManualDecisionRecord[]>;
}
