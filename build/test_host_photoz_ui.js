/* Pure renderer tests with synthetic data; no browser or real credentials. */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '../docs/host-photoz.js'), 'utf8');
const cols = ['transient_id', 'name', 'candidate_uid', 'association_status', 'confirmed_host_identity',
  'spectrum_status', 'candidate_specz', 'catalog_photoz', 'catalog_photoz_method', 'photoz_status',
  'photoz_quality_pass', 'sed_status', 'sed_rubin_z', 'sed_rubin_pass', 'sed_legacy_z', 'sed_legacy_pass',
  'sed_ps1_z', 'sed_ps1_pass', 'sed_adopted_as_hostz', 'science_usable'];
['rubin', 'legacy', 'ps1'].forEach(source=>['z16','z84','z025','z975','temperature','temperature_calibration_available','source_validation_pass','review_flags'].forEach(field=>cols.push('sed_'+source+'_'+field)));
['legacy_griz','legacy_grz'].forEach(method=>['low68','high68','low95','high95','support_pass'].forEach(field=>cols.push('expanded_'+method+'_'+field)));
cols.push('supplemental_sed_fits_json','supplemental_photometry_outcomes_json','supplemental_catalog_photoz_json');
const row = ['712345678901234567', '2025fixture', 'legacy:fixture', 'review_required', false,
  'verified_galaxy_specz', .2, .21, 'catalog_method', 'review_required', false,
  'failed_accuracy_validation', null, false, 3.1, false, null, false, false, false];
while (row.length<cols.length) row.push(null);
row[cols.indexOf('sed_legacy_z16')]=2.7;
row[cols.indexOf('sed_legacy_z84')]=3.4;
row[cols.indexOf('sed_legacy_temperature')]=3.08;
row[cols.indexOf('sed_legacy_temperature_calibration_available')]=true;
row[cols.indexOf('sed_legacy_source_validation_pass')]=false;
row[cols.indexOf('expanded_legacy_griz_low68')]=0.1;
row[cols.indexOf('expanded_legacy_griz_high68')]=0.5;
row[cols.indexOf('expanded_legacy_griz_support_pass')]=false;
row[cols.indexOf('supplemental_sed_fits_json')]=JSON.stringify([{source_catalog:'fixture_survey',aperture:'fixed_aperture',z_best:2.3456,quality_pass:false,covariance_used:true,review_flags:'failed',diagnostic_only:true,adopted_as_hostz:false}]);
function fixture(unlocked) {
  const root = {innerHTML:''};
  const S = {hostPhotozPublic:{status:'pending', summary:{}, validation:[]},
    hostPhotozTeam:{cols:cols.slice(), rows:[row.slice()]}, byName:new Map()};
  const X = {S, views:{}, team:{unlocked}, teamOffer:()=>false,
    U:{esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
      fint:value=>String(value), loadScript:()=>new Promise(()=>{})}};
  const context = {window:{TNSXApp:X, TNSX:{}}, document:{title:'', getElementById:id=>id==='view-host-photoz'?root:null}};
  vm.runInNewContext(source, context);
  X.views['host-photoz'].show();
  return {X, root};
}
const locked = fixture(false);
assert(!locked.root.innerHTML.includes(row[0]), 'locked page cannot contain transient IDs');
assert(!locked.root.innerHTML.includes('3.1000'), 'locked page cannot contain private diagnostics');
assert(!locked.root.innerHTML.includes('2.3456'), 'locked page cannot contain supplemental diagnostics');
const open = fixture(true);
assert(open.root.innerHTML.includes('Candidate spectrum z'));
assert(open.root.innerHTML.includes('0.2100'), 'existing catalog point estimate is retained');
assert(open.root.innerHTML.includes('3.1000'), 'failed SED remains in a separate diagnostic disclosure');
assert(open.root.innerHTML.includes('Not adopted as host redshift'));
assert(open.root.innerHTML.includes('Host identity: unconfirmed'));
assert(open.root.innerHTML.includes('Temperature 3.08'));
assert(open.root.innerHTML.includes('Separate expanded intervals'));
assert(open.root.innerHTML.includes('original point estimate is unchanged'));
assert(open.root.innerHTML.includes('Fresh source validation: not passed'));
assert(open.root.innerHTML.includes('Additional survey diagnostics'));
assert(open.root.innerHTML.includes('2.3456'));
assert(open.root.innerHTML.includes('covariance used: yes'));
const bad = {cols:cols.slice(), rows:[row.slice()]}; bad.rows[0][18]=true;
assert.throws(()=>open.X.checkHostPhotozTable(bad), /unexpected/);
console.log('host photo-z UI: locked boundary, candidate labels, catalog retention, unadopted SED and promotion guard pass');
