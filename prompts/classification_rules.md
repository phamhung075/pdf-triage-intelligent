🛑 MASTER AI CLASSIFICATION DECISION FLOW (BILINGUAL FRENCH & ENGLISH - FOLLOW IN STRICT ORDER):

STEP 1: BANK STATEMENTS, CHECK STATEMENTS & SAVINGS SUMMARIES (High Priority Override)
- Search document header, text, and filename for "RLV_CHQ", "RLV_", "RCHQ", "RCE", "SYN_EPARGNE", "SYN_EP_CREDIT", "Synthèse d'épargne", "Relevé de chèques", "Relevé de compte", "Bank Statement", "Account Statement", "Checking Account", "Savings Account", "Statement of Account", "Credit Card Statement", "Opening Balance", "Closing Balance", "Crédit Mutuel", "Société Générale", "BNP Paribas", "BoursoBank", "LCL", "La Banque Postale", "C/C EUROCOMPTE", "RELEVE DE COMPTE", "SOLDE CREDITEUR", or IBAN/RIB numbers.
- IF MATCH: -> Category = 'bank', Subcategory = Exact Bank Name (e.g. 'bnp_paribas', 'credit_mutuel', 'societe_generale', 'chase', 'barclays', 'hsbc').
- ⚠️ CRITICAL RULE: Ignore vendor or landlord names (like Foncia, SFR, France Travail, PayPal, Amazon) that appear inside internal transaction list rows or check list descriptions!

STEP 1B: FINES & TRAFFIC VIOLATIONS (AMENDES - High Priority Override)
- Search document for "Justificatif de règlement d'amende", "amende", "amendes", "amendes.gouv.fr", "antai", "avis de contravention", "procès-verbal", "PV d'amende", "Traffic fine", "Parking ticket", "Penalty charge notice".
- IF MATCH: -> Category = 'administrative', Subcategory = 'amende'.
- ⚠️ CRITICAL RULE: NEVER classify fines or penalty payment receipts as 'France Travail', 'correspondence', or 'courriers'!

STEP 2: TAX DOCUMENTS, KBIS & BUSINESS REGISTRATION (High Priority Override)
- Search document for "Kbis", "Extrait Kbis", "Avis d'impôt", "Avis d'imposition", "Prélèvements sociaux", "Revenus 2022", "Finances Publiques", "DGFIP", "Taxe foncière", "Taxe d'habitation", "BCTC", "Báo cáo tài chính", "Dossier administratif", "Tax Return", "Tax Assessment", "W-2", "Form 1040", "Tax Notice", "HMRC", "Property Tax", "Inland Revenue".
- IF MATCH: -> Category = 'administrative', Subcategory = 'kbis', 'impot', 'bctc', or 'dossier_administratif'.
- ⚠️ CRITICAL RULE: NEVER classify Kbis or tax forms as 'correspondence' or 'courriers'!

STEP 3: PAY SLIPS / PAYROLL (HIGH PRIORITY CATEGORY)
- Search document for "Bulletin de salaire", "Bulletin de paie", "Fiche de paie", "Salaire brut", "Net à payer", "Payslip", "Pay slip", "Paystub", "Pay stub", "Salary statement", "Wage statement", "Gross pay", "Net pay".
- IF MATCH: -> Category = 'bulletin_salaire', Subcategory = Exact Employer/Enterprise Name (e.g. 'employeur_x', 'globex', 'capgemini', 'ecole_x').
- ⚠️ CRITICAL RULE: NEVER put pay slips under 'invoices' (Factures)!

STEP 4: CONTRACTS & GENERAL CONDITIONS
- Search for "Contrat de travail", "CDI", "CDD", "Avenant au contrat", "Conditions générales", "Notice employeur", "Convention collective", "Rupture conventionnelle", "Acte de cession", "Cession de véhicule", "Acte de société", "Dépôt d'entreprise", "Employment contract", "Employment agreement", "Terms and conditions", "Non-disclosure agreement", "NDA", "Service agreement", "Lease agreement", "Tenancy agreement".
- IF MATCH: -> Category = 'contracts', Subcategory = Work, Conditions, or Document Type (e.g. 'cdi_cdd', 'conditions_generales', 'statuts_societe', 'acte_cession', 'pmsmp', 'pret_scooter').

STEP 5: IDENTITY, CIVIL PAPERS & VEHICLE REGISTRATION
- Search for "Passeport", "Passport", "Carte d'Identité", "CNI", "Pièce d'identité", "Titre de Séjour", "Récépissé de demande", "recHung", "Carte Vitale", "Permis de conduire", "DCES", "Accusé d'enregistrement de cession", "Carte grise", "Acte de mariage", "Acte de naissance", "Identity card", "ID card", "Driver's license", "Residence permit", "Visa", "Birth certificate", "Marriage certificate".
- IF MATCH: -> Category = 'identity', Subcategory = Document Type (e.g. 'passeport', 'titre_sejour', 'recipisse_sejour', 'carte_vitale', 'permis_conduire', 'carte_identite', 'carte_grise', 'acte_mariage', 'acte_naissance').

STEP 6: HEALTH, MEDICAL & WORK STOPPAGES
- Search for "Arrêt de travail", "Avis d'arrêt de travail", "Ameli", "Assurance Maladie", "CPAM", "Mutuelle", "Gan Santé", "Ordonnance", "Soins Dentaires", "Pharmacie", "Hospitalisation", "Health insurance", "Medical bill", "Medical claim", "Doctor's note", "Sick leave", "Medical statement".
- IF MATCH: -> Category = 'health', Subcategory = 'arret_travail' or Health Institution (e.g. 'ameli', 'gan_sante', 'clinic_x').

STEP 7: HOUSING, DOMICILE PROOF & TRANSPORTS
- Search for "Justificatif de domicile", "Attestation d'hébergement", "Attestation cercles", "Quittance de loyer", "Foncia", "Logement", "Bail d'habitation", "Proof of address", "Utility bill", "Rent receipt", "Calendrier bus", "Bus relais", "Navigo".
- IF MATCH: -> Category = 'housing' or 'administrative', Subcategory = 'justificatif_domicile', 'foncia', or 'navigo'.

STEP 8: GENERAL INSURANCE & THEFT CLAIMS
- Search for "Assurance Auto", "Assurance Habitation", "Prévoyance", "Responsabilité Civile", "Déclaration de vol", "Découverte de vol", "Dépôt de plainte", "Car insurance", "Auto insurance", "Home insurance", "Renters insurance", "Liability insurance", "Policy schedule", "Insurance certificate", "Allianz", "Macif", "Maaf".
- IF MATCH: -> Category = 'insurance', Subcategory = 'declaration_vol' or Company Name (e.g. 'allianz').

STEP 9: VENDOR INVOICES & BILLS (FACTURES)
- Search for "Facture n°", "Facture no", "Invoice", "Montant à payer", "Total TTC", "Bill", "Receipt", "Tax Invoice", "Amount Due", "Balance Due", "Total Due", "Payment Receipt", "SFR", "EDF", "Engie", "Free", "Orange", "Cdiscount", "Amazon", "PayPal".
- IF MATCH: -> Category = 'invoices', Subcategory = Vendor Name (e.g. 'sfr', 'edf', 'cdiscount', 'paypal', 'amazon').

STEP 10: EDUCATION, ACADEMIC & TRANSCRIPTS
- Search for "Relevé de notes", "Relevés de notes semestriels", "Bulletin de notes", "Alternance", "Attestation de stage", "Certificat de scolarité", "Diplôme", "Bachelor", "Attestation de formation", "Academic transcript", "Grade report", "Certificate of enrollment", "Diploma", "Degree certificate", "Tuition fee", "ECOLE_X", "ECOLE_Y", "EcoleZ", "OpenClassrooms".
- IF MATCH: -> Category = 'education', Subcategory = 'releve_notes', 'alternance', 'diplomes', or School/Company Name (e.g. 'globex', 'ecole_x', 'ecole_y').

STEP 11: RECRUITMENT
- Search for "Lettre de motivation", "CV", "Curriculum Vitae", "Candidature", "Postuler", "Cover letter", "Job application", "Resume".
- IF MATCH: -> Category = 'recruitment', Subcategory = 'lettres_motivation'.

STEP 12: POSTAL MAIL & EMAILS
- Plain postal letters or emails without invoice, tax, or contract context -> Category = 'correspondence'.

STEP 13: TECHNICAL MANUALS & REPORTS
- Technical guides -> Category = 'technical'. Project reports -> Category = 'reports'.
