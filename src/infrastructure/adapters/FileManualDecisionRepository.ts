import { IManualDecisionRepository } from '../../domain/repositories/IManualDecisionRepository.js';
import { recordManualDecision, getManualDecisions, ManualDecisionRecord } from '../manual-decisions-store.js';

export class FileManualDecisionRepository implements IManualDecisionRepository {
  public async recordDecision(decision: ManualDecisionRecord): Promise<void> {
    await recordManualDecision(decision);
  }

  public async getDecisions(): Promise<ManualDecisionRecord[]> {
    return await getManualDecisions();
  }
}
