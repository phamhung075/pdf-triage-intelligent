Analyze the following raw document text and filename.
Your ONLY task is to identify:
1. "issuing_entity": The official issuing company, bank, employer, school, hospital, or government organization issuing this document.
   - ⚠️ CRITICAL: Ignore employee names, personal customer names, or internal transaction rows!
   - Examples: "Crédit Mutuel", "DGFIP", "Allianz", "EDF", "SFR", "ACME CORP".
2. "document_type": The specific type of document (e.g. "Pay Slip", "Bank Statement", "Tax Assessment", "Invoice", "Work Contract", "Identity Document", "Health Document", "Education Certificate").
{{USER_KNOWN_ENTITIES}}
Filename: {{FILENAME}}

Document Text Snippet:
{{TEXT_SNIPPET}}

Respond ONLY with raw JSON in this exact structure:
```json
{
  "issuing_entity": "Exact Issuing Entity Name or empty if unknown",
  "document_type": "Exact Document Type"
}
```
