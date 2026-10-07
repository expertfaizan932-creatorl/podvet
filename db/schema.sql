-- PodVet â€” isolated platform database schema.
-- This creates the platform DB (default: podvet) that hosts clinic id 1 and the
-- `clinics` metadata table. Each additional clinic gets its own database
-- (podvet_clinic_<id>) auto-created by the server based on this schema.
--
-- The plain `podvet` / `clinic_*` databases from other installs are NEVER
-- touched: this schema uses its own database name (DB_NAME, default "podvet")
-- and its own clinic prefix (CLINIC_PREFIX, default "podvet_clinic_").

CREATE DATABASE IF NOT EXISTS `podvet` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `podvet`;

-- â”€â”€ Platform-level tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE IF NOT EXISTS clinics (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('OWNER','ADMIN','USER') DEFAULT 'USER',
    phone_number VARCHAR(50),
    clinic_id INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Password-reset codes. Platform-level (never cloned into a clinic database):
-- the code is looked up by the owner's email, which lives in the platform
-- `users` table. Only the HASH of the code is stored, so a leaked table read
-- must not hand an attacker working reset codes. `expires_at` is enforced in
-- the query rather than by a sweeper job, so there is nothing to keep running.
CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    used_at DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_password_resets_email (email),
    INDEX idx_password_resets_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- â”€â”€ Clinic-level tables (clone target for podvet_clinic_<id>) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CREATE TABLE IF NOT EXISTS clinic_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255),
    brand_color VARCHAR(20),
    logo_url VARCHAR(500),
    address TEXT,
    phone VARCHAR(50),
    -- White-label extras. `tagline` is the italic line under the masthead on
    -- every generated document; `powered_by` is the vendor footer on invoices,
    -- expense reports, POS/lab slips and the app sidebar. Both default to
    -- NULL (i.e. "print nothing") so a clinic that never fills them in gets no
    -- vendor attribution at all -- these used to be hardcoded strings
    -- ("Powered by Parkar Technologies LLC." on every document).
    tagline VARCHAR(255) DEFAULT NULL,
    powered_by VARCHAR(255) DEFAULT NULL,
    group_products_on_invoice TINYINT(1) NOT NULL DEFAULT 0,
    bank_name VARCHAR(255) DEFAULT NULL,
    bank_account_number VARCHAR(100) DEFAULT NULL,
    pos_show_logo TINYINT(1) NOT NULL DEFAULT 1,
    pos_show_clinic_phone TINYINT(1) NOT NULL DEFAULT 0,
    pos_show_client_phone TINYINT(1) NOT NULL DEFAULT 0,
    pos_show_vet_name TINYINT(1) NOT NULL DEFAULT 0,
    pos_show_address TINYINT(1) NOT NULL DEFAULT 0,
    pos_show_bank_details TINYINT(1) NOT NULL DEFAULT 0,
    pos_header_show_clinic_name TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS branches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_name VARCHAR(255) NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    address TEXT,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_branches_branch_name (branch_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_name VARCHAR(255) NOT NULL,
    contact_number VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT NOT NULL,
    pet_name VARCHAR(255) NOT NULL,
    sex ENUM('Male','Female','Unknown') DEFAULT 'Unknown',
    species VARCHAR(100) DEFAULT 'Dog',
    breed VARCHAR(255),
    color VARCHAR(100),
    date_of_birth DATE,
    age VARCHAR(50),
    is_neutered TINYINT(1) DEFAULT 0,
    is_microchipped TINYINT(1) DEFAULT 0,
    deceased TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    position VARCHAR(255),
    designation VARCHAR(255),
    salary DECIMAL(12,2) DEFAULT 0,
    contact VARCHAR(50),
    joined_on DATE,
    -- JSON array of { platform, url } links (Instagram/Facebook/LinkedIn/
    -- Twitter/WhatsApp/Website). TEXT rather than a JSON column so a stray
    -- non-JSON value can never make an employee write fail.
    social_links TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) DEFAULT 'General',
    base_rate DECIMAL(12,2) DEFAULT 0,
    purchase_price DECIMAL(12,2) DEFAULT 0,
    is_grooming TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Name+category, not name alone: a clinic may legitimately offer the same
    -- service name under two categories (e.g. "Bathing" under Grooming and
    -- under Hygiene). This pair is what the seed rows below collide on.
    UNIQUE KEY uq_services_name_category (name, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    barcode_number VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    price DECIMAL(12,2) DEFAULT 0,
    quantity INT DEFAULT 0,
    category VARCHAR(100),
    vendor_id INT,
    vendor_share_percentage DECIMAL(5,2) DEFAULT 0,
    vendor_credit_percent DECIMAL(5,2) DEFAULT 0,
    vendor_clinic_fixed_per_unit DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vendors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    contact_number VARCHAR(50),
    email VARCHAR(255),
    address VARCHAR(500),
    city VARCHAR(100),
    website VARCHAR(255),
    category VARCHAR(100),
    notes TEXT,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vendor_settlements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT,
    start_date DATE,
    end_date DATE,
    gross_sales DECIMAL(12,2) DEFAULT 0,
    vendor_share DECIMAL(12,2) DEFAULT 0,
    clinic_share DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Stock bought from a vendor (as opposed to vendor_settlements, which is what
-- consignment sales owe). Recording a purchase adds its linked products'
-- quantity back to inventory; deleting it takes that stock back out.
CREATE TABLE IF NOT EXISTS vendor_purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor_id INT NOT NULL,
    purchase_date DATE NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'paid',
    total_amount DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_vendor_purchases_vendor (vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vendor_purchase_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    purchase_id INT NOT NULL,
    product_id INT DEFAULT NULL,
    item_name VARCHAR(255) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    unit_price DECIMAL(12,2) DEFAULT 0,
    line_total DECIMAL(12,2) DEFAULT 0,
    KEY idx_vendor_purchase_items_purchase (purchase_id),
    FOREIGN KEY (purchase_id) REFERENCES vendor_purchases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS coupons (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type ENUM('PERCENT','FIXED') DEFAULT 'PERCENT',
    discount_value DECIMAL(12,2) DEFAULT 0,
    start_date DATE,
    expiry_date DATE,
    usage_limit INT DEFAULT 0,
    times_used INT DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- uq_expense_categories_name: setup-server.sh re-imports this file on EVERY
-- deploy, and this table is one of the seeded ones below. Without a unique key
-- each deploy appended a fresh copy of all six defaults (30 deploys had
-- produced 164 rows, all six names repeated 30x in the Add-Expense dropdown).
CREATE TABLE IF NOT EXISTS expense_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    UNIQUE KEY uq_expense_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category_id INT,
    amount DECIMAL(12,2) DEFAULT 0,
    date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    client_id INT NOT NULL,
    appointment_date DATE NOT NULL,
    appointment_time TIME,
    notes TEXT,
    status ENUM('CONFIRMED','CANCELLED','COMPLETED') DEFAULT 'CONFIRMED',
    doctor VARCHAR(255),
    branch_id INT,
    prediscount_type ENUM('PERCENT','FIXED') DEFAULT NULL,
    prediscount_value DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointment_services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NOT NULL,
    service_id INT,
    service_name VARCHAR(255),
    quantity INT DEFAULT 1,
    rate DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointment_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NOT NULL,
    product_id INT,
    quantity INT DEFAULT 1,
    price DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    locked TINYINT(1) DEFAULT 0,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT,
    client_id INT,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    pet_name VARCHAR(255),
    subtotal DECIMAL(12,2) DEFAULT 0,
    discount DECIMAL(12,2) DEFAULT 0,
    final_total DECIMAL(12,2) DEFAULT 0,
    amount_paid DECIMAL(12,2) DEFAULT 0,
    status ENUM('PAID','UNPAID','PARTIALLY_PAID') DEFAULT 'UNPAID',
    payment_mode ENUM('CASH','CARD','BANK_TRANSFER') DEFAULT 'CASH',
    coupon_code VARCHAR(50),
    invoice_no VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    billing_id INT NOT NULL,
    product_id INT,
    name VARCHAR(255),
    quantity INT DEFAULT 1,
    price DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    FOREIGN KEY (billing_id) REFERENCES billing(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS soap_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    appointment_id INT,
    boarding_stay_id INT,
    doctor VARCHAR(255),
    subjective TEXT,
    objective TEXT,
    assessment TEXT,
    diagnosis TEXT,
    `plan` TEXT,
    temperature DECIMAL(5,2),
    temperature_input_unit VARCHAR(10) DEFAULT 'C',
    heart_rate INT,
    respiratory_rate INT,
    weight DECIMAL(8,2),
    weight_input_unit VARCHAR(10) DEFAULT 'kg',
    bcs INT DEFAULT NULL,
    mucous_membrane VARCHAR(50) DEFAULT NULL,
    crt DECIMAL(3,1) DEFAULT NULL,
    crt_under_2 TINYINT(1) DEFAULT NULL,
    pulse_quality VARCHAR(50) DEFAULT NULL,
    hydration_status VARCHAR(50) DEFAULT NULL,
    mentation VARCHAR(50) DEFAULT NULL,
    visit_type VARCHAR(50) DEFAULT NULL,
    condition_status VARCHAR(50) DEFAULT NULL,
    is_pregnant TINYINT(1) DEFAULT 0,
    has_anemia TINYINT(1) DEFAULT 0,
    vaccination_given TINYINT(1) DEFAULT 0,
    deworming_given TINYINT(1) DEFAULT 0,
    diarrhea_type VARCHAR(50) DEFAULT NULL,
    vomit_type VARCHAR(50) DEFAULT NULL,
    ddx TEXT,
    prognosis TEXT,
    next_visit_days INT DEFAULT NULL,
    doctor_notes TEXT,
    exam_eyes_normal TINYINT(1) DEFAULT 1,
    exam_eyes_note TEXT,
    exam_eyes_discharge_type VARCHAR(50) DEFAULT NULL,
    exam_eyes_color VARCHAR(50) DEFAULT NULL,
    exam_eyes_cornea VARCHAR(50) DEFAULT NULL,
    exam_eyes_pupils VARCHAR(50) DEFAULT NULL,
    exam_ears_normal TINYINT(1) DEFAULT 1,
    exam_ears_note TEXT,
    exam_ears_discharge_type VARCHAR(50) DEFAULT NULL,
    exam_ears_odor VARCHAR(50) DEFAULT NULL,
    exam_ears_appearance VARCHAR(50) DEFAULT NULL,
    exam_ears_pain TINYINT(1) DEFAULT NULL,
    exam_oral_normal TINYINT(1) DEFAULT 1,
    exam_oral_note TEXT,
    exam_skin_normal TINYINT(1) DEFAULT 1,
    exam_skin_note TEXT,
    exam_lymph_normal TINYINT(1) DEFAULT 1,
    exam_lymph_note TEXT,
    exam_cardio_normal TINYINT(1) DEFAULT 1,
    exam_cardio_note TEXT,
    exam_resp_normal TINYINT(1) DEFAULT 1,
    exam_resp_note TEXT,
    exam_gi_normal TINYINT(1) DEFAULT 1,
    exam_gi_note TEXT,
    exam_musculo_normal TINYINT(1) DEFAULT 1,
    exam_musculo_note TEXT,
    exam_neuro_normal TINYINT(1) DEFAULT 1,
    exam_neuro_note TEXT,
    exam_uro_normal TINYINT(1) DEFAULT 1,
    exam_uro_note TEXT,
    tests_advised TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vaccinations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    vaccine_name VARCHAR(255),
    administered_on DATE,
    next_due_date DATE,
    batch_number VARCHAR(100),
    notes TEXT,
    administered_by VARCHAR(255),
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dewormings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    product_name VARCHAR(255),
    administered_on DATE,
    next_due_date DATE,
    batch_number VARCHAR(100),
    notes TEXT,
    administered_by VARCHAR(255),
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    prescribed_by VARCHAR(255),
    prescribed_on DATE,
    notes TEXT,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescription_medications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prescription_id INT NOT NULL,
    name VARCHAR(255),
    dosage VARCHAR(255),
    frequency VARCHAR(255),
    duration VARCHAR(255),
    FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_test_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    test_name VARCHAR(255),
    test_date DATE,
    result_summary TEXT,
    result_value VARCHAR(255),
    reference_range VARCHAR(255),
    status VARCHAR(50),
    lab_name VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS procedures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    procedure_name VARCHAR(255),
    performed_on DATE,
    performed_by VARCHAR(255),
    notes TEXT,
    outcome TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS procedure_materials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    procedure_id INT NOT NULL,
    product_id INT,
    material_name VARCHAR(255),
    quantity DECIMAL(12,2) DEFAULT 0,
    dose VARCHAR(255),
    route VARCHAR(255),
    batch_number VARCHAR(100),
    notes TEXT,
    FOREIGN KEY (procedure_id) REFERENCES procedures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS body_weight_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    soap_note_id INT,
    weight DECIMAL(8,2),
    weight_unit VARCHAR(20),
    recorded_on DATE,
    recorded_by VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pet_id INT NOT NULL,
    test_type VARCHAR(255),
    custom_test_type VARCHAR(255),
    file_url VARCHAR(1000),
    file_type VARCHAR(50),
    original_filename VARCHAR(500),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entity_type ENUM('appointment','pet') DEFAULT 'pet',
    entity_id INT,
    remind_on DATE,
    note TEXT,
    is_dismissed TINYINT(1) DEFAULT 0,
    due_date DATE,
    doctor VARCHAR(255),
    pet_name VARCHAR(255),
    client_name VARCHAR(255),
    contact_number VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    branch_id INT,
    thumbnail_url VARCHAR(1000),
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS form_pages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    form_id INT NOT NULL,
    page_index INT DEFAULT 0,
    image_url VARCHAR(1000),
    fields JSON,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cage_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_id INT,
    type_name VARCHAR(255),
    is_free_area TINYINT(1) DEFAULT 0,
    quantity INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cage_units (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cage_type_id INT NOT NULL,
    unit_label VARCHAR(100),
    is_active TINYINT(1) DEFAULT 1,
    FOREIGN KEY (cage_type_id) REFERENCES cage_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    feeding_interval_minutes INT DEFAULT 480,
    monitoring_interval_minutes INT DEFAULT 60,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_stays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    branch_id INT,
    pet_id INT NOT NULL,
    client_id INT,
    cage_unit_id INT,
    service_id INT,
    date_in DATE,
    date_out DATE,
    expected_checkout_date DATE,
    status VARCHAR(50),
    purpose VARCHAR(255),
    hospitalization_purpose VARCHAR(255),
    requires_monitoring TINYINT(1) DEFAULT 0,
    notes TEXT,
    needs_vaccination TINYINT(1) DEFAULT 0,
    needs_deworming TINYINT(1) DEFAULT 0,
    owner_provides_food TINYINT(1) DEFAULT 0,
    feeding_interval_minutes INT DEFAULT 480,
    monitoring_interval_minutes INT DEFAULT 60,
    billing_id INT,
    amount_paid DECIMAL(12,2) DEFAULT 0,
    payment_mode VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_care_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stay_id INT NOT NULL,
    log_type VARCHAR(50),
    logged_by VARCHAR(255),
    notes TEXT,
    product_id INT,
    item_name VARCHAR(255),
    display_name VARCHAR(255),
    quantity DECIMAL(12,2) DEFAULT 0,
    price DECIMAL(12,2) DEFAULT 0,
    medication_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stay_id) REFERENCES boarding_stays(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS boarding_medications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stay_id INT NOT NULL,
    drug_name VARCHAR(255),
    dose VARCHAR(255),
    interval_minutes INT,
    product_id INT,
    quantity DECIMAL(12,2) DEFAULT 0,
    price DECIMAL(12,2) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    started_at DATETIME,
    discontinued_at DATETIME,
    FOREIGN KEY (stay_id) REFERENCES boarding_stays(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- â”€â”€ Seed data (safe to re-run) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

INSERT INTO clinics (id, clinic_name, slug) VALUES (1, 'PodVet Clinic', 'podvet')
ON DUPLICATE KEY UPDATE slug = VALUES(slug);

INSERT INTO clinic_settings (id, clinic_name, brand_color) VALUES (1, 'PodVet Clinic', '#92CAED')
ON DUPLICATE KEY UPDATE clinic_name = VALUES(clinic_name), brand_color = VALUES(brand_color);

-- Default admin user (node-bcrypt password: admin123)
INSERT INTO users (name, username, email, password, role, clinic_id) VALUES
('Admin', 'admin', 'admin@podvet.local', '$2b$10$yWrBrWrfu9d0PrtIvh9rT.KBG8CPmoPOQyb.IxYYlIX7vtgcR/iuG', 'OWNER', 1)
ON DUPLICATE KEY UPDATE username = VALUES(username);

INSERT INTO branches (branch_name, is_active)
SELECT 'Main Branch', 1
WHERE NOT EXISTS (SELECT 1 FROM branches WHERE branch_name = 'Main Branch');

-- Every seed below is an anti-join (insert only when the row is missing), not
-- a bare VALUES list and not ON DUPLICATE KEY: setup-server.sh re-imports this
-- file on EVERY deploy, and a bare VALUES list appended a fresh copy of every
-- default row each time. The unique keys the CREATE TABLE statements declare
-- are only added to pre-existing tables by the guarded ALTERs at the end of
-- this file, so an install whose key is not in place yet must still not
-- accumulate duplicates.

INSERT INTO expense_categories (name, description)
SELECT s.name, s.description
FROM (
    SELECT 'Rent' AS name, 'Office/clinic rent' AS description
    UNION ALL SELECT 'Utilities', 'Electricity, water, internet'
    UNION ALL SELECT 'Supplies', 'Medical and office supplies'
    UNION ALL SELECT 'Salary', 'Employee salaries'
    UNION ALL SELECT 'Maintenance', 'Equipment and facility maintenance'
    UNION ALL SELECT 'Other', 'Miscellaneous expenses'
) s
LEFT JOIN expense_categories ec ON ec.name = s.name
WHERE ec.id IS NULL;

INSERT INTO services (name, category, base_rate)
SELECT s.name, s.category, s.base_rate
FROM (
    SELECT 'Consultation' AS name, 'General' AS category, 500 AS base_rate
    UNION ALL SELECT 'Vaccination', 'Medical', 800
    UNION ALL SELECT 'Surgery', 'Medical', 5000
    UNION ALL SELECT 'Grooming - Basic', 'Grooming', 300
    UNION ALL SELECT 'Grooming - Premium', 'Grooming', 600
    UNION ALL SELECT 'Deworming', 'Medical', 400
    UNION ALL SELECT 'Lab Test', 'Laboratory', 1200
    UNION ALL SELECT 'X-Ray', 'Laboratory', 2500
    UNION ALL SELECT 'Boarding - Standard', 'Boarding', 500
    UNION ALL SELECT 'Boarding - Premium', 'Boarding', 800
) s
LEFT JOIN services sv ON sv.name = s.name AND sv.category = s.category
WHERE sv.id IS NULL;

-- Unique keys on pre-existing tables (idempotent).
--
-- CREATE TABLE IF NOT EXISTS above is a no-op on a table that already exists,
-- so these keys have to be added separately. Each ALTER is skipped while the
-- table still holds duplicates, because MySQL rejects it in that state:
-- server.js's startup migration (dedupeSeedRows) collapses the duplicates
-- first and adds the key on its next pass, and the next deploy picks it up
-- here. The duplicate check is also what stops a schema import from aborting
-- the deploy, since setup-server.sh runs under `set -e`.

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expense_categories'
       AND INDEX_NAME = 'uq_expense_categories_name') > 0,
  'DO 0',
  IF((SELECT COUNT(*) FROM (SELECT name FROM expense_categories
        GROUP BY name HAVING COUNT(*) > 1) d) > 0,
     'DO 0',
     'ALTER TABLE expense_categories ADD UNIQUE KEY uq_expense_categories_name (name)'));
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
       AND INDEX_NAME = 'uq_branches_branch_name') > 0,
  'DO 0',
  IF((SELECT COUNT(*) FROM (SELECT branch_name FROM branches
        GROUP BY branch_name HAVING COUNT(*) > 1) d) > 0,
     'DO 0',
     'ALTER TABLE branches ADD UNIQUE KEY uq_branches_branch_name (branch_name)'));
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'services'
       AND INDEX_NAME = 'uq_services_name_category') > 0,
  'DO 0',
  IF((SELECT COUNT(*) FROM (SELECT name, category FROM services
        GROUP BY name, category HAVING COUNT(*) > 1) d) > 0,
     'DO 0',
     'ALTER TABLE services ADD UNIQUE KEY uq_services_name_category (name, category)'));
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;