const VISIT_TYPES = {
  delivery: 'Delivery',
  merchandising: 'Merchandising',
  sales_call: 'Sales call',
  field_service: 'Field service / equipment',
  contractor: 'Contractor',
  auditor: 'Auditor or inspector',
  corporate: 'Corporate visitor',
};

const ROLES = {
  rep: 'Vendor rep',
  field_service: 'Field service rep',
  visitor: 'Other visitor',
  receiver: 'Receiver',
  store_manager: 'Store manager',
  merchant: 'HQ merchant',
  dsd_ops: 'DSD ops / compliance',
  admin: 'Administrator',
};

const VENDOR_ROLES = ['rep', 'field_service', 'visitor'];
const STORE_ROLES = ['receiver', 'store_manager'];
const HQ_ROLES = ['merchant', 'dsd_ops', 'admin'];

const WORK_TYPES = {
  delivery: 'Delivered',
  merchandise: 'Merchandised',
  pull_up: 'Pulled out-of-date product',
  reset: 'Reset completed',
  credit: 'Credit / return',
  repair: 'Equipment repair',
  maintenance: 'Scheduled maintenance',
  install: 'Install',
  other: 'Other',
};

const COVERAGE_TYPES = [
  'Commercial general liability',
  'Commercial auto liability',
  "Workers' compensation and employer's liability",
  'Product liability',
  'Umbrella or excess liability',
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

module.exports = { VISIT_TYPES, ROLES, VENDOR_ROLES, STORE_ROLES, HQ_ROLES, WORK_TYPES, COVERAGE_TYPES, DAYS };
