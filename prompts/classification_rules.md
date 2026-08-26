🛑 MASTER AI CLASSIFICATION DECISION FLOW (BILINGUAL FRENCH & ENGLISH - FOLLOW IN STRICT ORDER):
{{USER_PRIORITY_RULES}}
STEP 1: BANK STATEMENTS, CHECK STATEMENTS & SAVINGS SUMMARIES (High Priority Override)
- Search document header, text, and filename for "Synthèse d'épargne", "Relevé de chèques", "Relevé de compte", "Relevé de carte", "Bank Statement", "Account Statement", "Checking Account", "Savings Account", "Statement of Account", "Credit Card Statement", "Opening Balance", "Closing Balance", "RELEVE DE COMPTE", "SOLDE CREDITEUR", "SOLDE DEBITEUR", a bank name, or IBAN/RIB numbers.
- IF MATCH: -> Category = 'bank', Subcategory = Exact Bank Name (e.g. 'bnp_paribas', 'credit_mutuel', 'societe_generale', 'chase', 'barclays', 'hsbc').
- ⚠️ CRITICAL RULE: Ignore vendor, employer, agency or landlord names (like SFR, France Travail, PayPal, Amazon) that appear inside internal transaction list rows or check list descriptions!

STEP 1B: FINES & TRAFFIC VIOLATIONS (AMENDES - High Priority Override)
- Search document for "Justificatif de règlement d'amende", "amende", "amendes", "amendes.gouv.fr", "antai", "avis de contravention", "procès-verbal", "PV d'amende", "Traffic fine", "Parking ticket", "Penalty charge notice".
- IF MATCH: -> Category = 'administrative', Subcategory = 'amende'.
- ⚠️ CRITICAL RULE: NEVER classify fines or penalty payment receipts as 'France Travail', 'correspondence', or 'courriers'!

STEP 2: TAX DOCUMENTS, KBIS & BUSINESS REGISTRATION (High Priority Override)
- Search document for "Kbis", "Extrait Kbis", "Avis d'impôt", "Avis d'imposition", "Prélèvements sociaux", "Revenus <ANNÉE>", "Finances Publiques", "DGFIP", "Taxe foncière", "Taxe d'habitation", "Dossier administratif", "Tax Return", "Tax Assessment", "W-2", "Form 1040", "Tax Notice", "HMRC", "Property Tax", "Inland Revenue".
- IF MATCH: -> Category = 'administrative', Subcategory = 'kbis', 'impot', or 'dossier_administratif'.
- ⚠️ CRITICAL RULE: NEVER classify Kbis or tax forms as 'correspondence' or 'courriers'!

STEP 3: PAY SLIPS / PAYROLL (HIGH PRIORITY CATEGORY)
- Search document for "Bulletin de salaire", "Bulletin de paie", "Fiche de paie", "Salaire brut", "Net à payer", "Payslip", "Pay slip", "Paystub", "Pay stub", "Salary statement", "Wage statement", "Gross pay", "Net pay".
- IF MATCH: -> Category = 'bulletin_salaire', Subcategory = Exact Employer/Enterprise Name as printed in the document (e.g. 'acme_corp', 'globex_sarl').
- ⚠️ CRITICAL RULE: NEVER put pay slips under 'invoices' (Factures)!

STEP 4: CONTRACTS & GENERAL CONDITIONS
- Search for "Contrat de travail", "CDI", "CDD", "Avenant au contrat", "Conditions générales", "Notice employeur", "Convention collective", "Rupture conventionnelle", "Acte de cession", "Cession de véhicule", "Acte de société", "Dépôt d'entreprise", "Employment contract", "Employment agreement", "Terms and conditions", "Non-disclosure agreement", "NDA", "Service agreement", "Lease agreement", "Tenancy agreement".
- IF MATCH: -> Category = 'contracts', Subcategory = Work, Conditions, or Document Type (e.g. 'cdi_cdd', 'conditions_generales', 'statuts_societe', 'acte_cession', 'bail_habitation', 'nda').

STEP 5: IDENTITY, CIVIL PAPERS & VEHICLE REGISTRATION
- Search for "Passeport", "Passport", "Carte d'Identité", "CNI", "Pièce d'identité", "Titre de Séjour", "Récépissé de demande", "Carte Vitale", "Permis de conduire", "Accusé d'enregistrement de cession", "Carte grise", "Certificat d'immatriculation", "Acte de mariage", "Acte de naissance", "Identity card", "ID card", "Driver's license", "Residence permit", "Visa", "Birth certificate", "Marriage certificate".
- IF MATCH: -> Category = 'identity', Subcategory = Document Type (e.g. 'passeport', 'titre_sejour', 'recipisse_sejour', 'carte_vitale', 'permis_conduire', 'carte_identite', 'carte_grise', 'acte_mariage', 'acte_naissance').

STEP 6: HEALTH, MEDICAL & WORK STOPPAGES
- Search for "Arrêt de travail", "Avis d'arrêt de travail", "Ameli", "Assurance Maladie", "CPAM", "Mutuelle", "Ordonnance", "Soins Dentaires", "Pharmacie", "Hospitalisation", "Health insurance", "Medical bill", "Medical claim", "Doctor's note", "Sick leave", "Medical statement".
- IF MATCH: -> Category = 'health', Subcategory = 'arret_travail' or the Health Institution / practitioner name as printed (e.g. 'ameli', 'cpam').

STEP 7: HOUSING, DOMICILE PROOF & TRANSPORTS
- Search for "Justificatif de domicile", "Attestation d'hébergement", "Quittance de loyer", "Logement", "Bail d'habitation", "Régularisation de charges", "Proof of address", "Utility bill", "Rent receipt", "Calendrier bus", "Navigo", "Abonnement transport".
- IF MATCH: -> Category = 'housing' or 'administrative', Subcategory = 'justificatif_domicile', the property manager / landlord name as printed, or 'navigo'.

STEP 8: GENERAL INSURANCE & THEFT CLAIMS
- Search for "Assurance Auto", "Assurance Habitation", "Prévoyance", "Responsabilité Civile", "Déclaration de vol", "Découverte de vol", "Dépôt de plainte", "Car insurance", "Auto insurance", "Home insurance", "Renters insurance", "Liability insurance", "Policy schedule", "Insurance certificate", "Allianz", "Macif", "Maaf".
- IF MATCH: -> Category = 'insurance', Subcategory = 'declaration_vol' or Company Name (e.g. 'allianz').

STEP 9: VENDOR INVOICES & BILLS (FACTURES)
- Search for "Facture n°", "Facture no", "Invoice", "Montant à payer", "Total TTC", "Bill", "Receipt", "Tax Invoice", "Amount Due", "Balance Due", "Total Due", "Payment Receipt", "SFR", "EDF", "Engie", "Free", "Orange", "Cdiscount", "Amazon", "PayPal".
- IF MATCH: -> Category = 'invoices', Subcategory = Vendor Name (e.g. 'sfr', 'edf', 'cdiscount', 'paypal', 'amazon').

STEP 10: EDUCATION, ACADEMIC & TRANSCRIPTS
- Search for "Relevé de notes", "Relevés de notes semestriels", "Bulletin de notes", "Alternance", "Attestation de stage", "Certificat de scolarité", "Diplôme", "Bachelor", "Attestation de formation", "Academic transcript", "Grade report", "Certificate of enrollment", "Diploma", "Degree certificate", "Tuition fee".
- IF MATCH: -> Category = 'education', Subcategory = 'releve_notes', 'alternance', 'diplomes', or the School / Training Company Name as printed in the document.

STEP 11: RECRUITMENT
- Search for "Lettre de motivation", "CV", "Curriculum Vitae", "Candidature", "Postuler", "Cover letter", "Job application", "Resume".
- IF MATCH: -> Category = 'recruitment', Subcategory = 'lettres_motivation'.

STEP 12: POSTAL MAIL & EMAILS
- Plain postal letters or emails without invoice, tax, or contract context -> Category = 'correspondence'.

STEP 13: TECHNICAL MANUALS & REPORTS
- Technical guides -> Category = 'technical'. Project reports -> Category = 'reports'.
