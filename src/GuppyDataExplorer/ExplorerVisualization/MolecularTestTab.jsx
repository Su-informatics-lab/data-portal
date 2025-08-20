import React, { Fragment } from 'react';
import MolecularBoxplot from './MolecularBoxplot';
import MolecularLineChart from './MolecularLineChart';

// keep hardcoded units as fallback
const LAB_TEST_UNITS_FALLBACK = {
  'ACE': 'ug/L',
  'Albumin': 'g/dL',
  'ALT': 'U/L',
  'AST': 'U/L',
  'Alkaline Phosphatase': 'U/L',
  'BUN': 'mg/dL',
  'Creatinine': 'mg/dL',
  'Cystatin-C': 'mg/L',
  'Direct Bilirubin': 'mg/dL',
  'Estimated GFR': 'mL/min/1.73m²',
  'INR': '',
  'Prothrombin Time': 'sec',
  'Total Bilirubin': 'mg/dL',
  'Total Protein': 'g/dL',
  // Urine biomarkers
  'Urine NGAL': 'ng/mL',
  'Urine KIM-1': 'ng/mL',
  'Urine Creatinine': 'mg/dL',
  'Urine IL-18': 'pg/mL',
  'Urine L-FABP': 'pg/mL',
  // Additional biomarkers
  'Renin': 'ng/mL',
  // New
  'IL-1RA': 'pg/mL'
};

export class MolecularTestTab extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      labTestTypes: [],
      data: null,
      testUnitsMap: new Map()
    };
  }

  componentDidMount() {
    if (this.props.casecount > 0 && this.props.casecount <= 10000) {
      this.fetchData(this.props.casecount)
    }
  }

  componentWillReceiveProps(nextProps) {
    if (this.props.casecount !== nextProps.casecount) {
      if (nextProps.casecount >= 0 && nextProps.casecount <= 10000) {
        this.fetchData(nextProps.casecount)
      }
    }
  }

  extractTestUnits(data) {
    const unitsMap = new Map();
    const unitCounts = new Map();

    // first pass: count the occurrences of each test_unit
    data.forEach(item => {
      const testName = item['laboratory_test'];
      const testUnit = item['test_unit'];

      if (testName && testUnit && testUnit.trim() !== '') {
        if (!unitCounts.has(testName)) {
          unitCounts.set(testName, new Map());
        }

        const testUnitCounts = unitCounts.get(testName);
        const normalizedUnit = testUnit.trim();
        testUnitCounts.set(normalizedUnit, (testUnitCounts.get(normalizedUnit) || 0) + 1);
      }
    });

    // second pass: select the best unit for each laboratory_test
    const unique = [...new Set(data.map(item => item['laboratory_test']))];
    unique.forEach(testName => {
      if (unitCounts.has(testName)) {
        // select the unit with the most occurrences
        const testUnitCounts = unitCounts.get(testName);
        let bestUnit = '';
        let maxCount = 0;

        testUnitCounts.forEach((count, unit) => {
          if (count > maxCount) {
            maxCount = count;
            bestUnit = unit;
          }
        });

        unitsMap.set(testName, bestUnit);
      } else {
        // no valid unit, use fallback
        unitsMap.set(testName, LAB_TEST_UNITS_FALLBACK[testName] || '');
      }
    });

    this.setState({ testUnitsMap: unitsMap });
  }

  getLabTestType(data) {
    const unique = [...new Set(data.map(item => item['laboratory_test']))];
    this.setState({
      labTestTypes: unique
    });

    // extract unit information
    this.extractTestUnits(data);
  }

  // update: helper function to dynamically get the unit
  getTestUnit = (testName) => {
    return this.state.testUnitsMap.get(testName) || '';
  }

  // update: helper function to format the title
  formatTitle = (testName, studyType) => {
    const unit = this.getTestUnit(testName);
    const unitSuffix = unit ? ` (${unit})` : '';
    return `${testName}${unitSuffix} ${studyType}`;
  }

  fetchData(casecount) {
    const size = casecount
    const offset = 0
    const sort = []
    this.props.fetchAndUpdateRawData({
      offset, size, sort
    }).then((res) => {
      this.getLabTestType(res.data)
      this.setState({
        data: res
      })
    });
  };

  componentWillUnmount() {
    this.setState = (state, callback) => {
      return;
    };
  }

  render() {
    return (
      <div>
        {this.state.data && <div className="summary-chart-group" style={{ height: 'fit-content', minHeight: 400 }}>
          {this.state.labTestTypes.length > 0 && this.state.labTestTypes.map((element, i) => {
            return (
              <Fragment key={i}>
                <MolecularBoxplot
                  casecount={this.props.casecount}
                  tab={'lab_results'}
                  data={this.state.data}
                  category={'case_arm'}
                  attribute={element}
                  unit={this.getTestUnit(element)}
                  title={this.formatTitle(element, "Clinical Trial")}
                />
                <MolecularLineChart
                  casecount={this.props.casecount}
                  data={this.state.data}
                  tab={'lab_results'}
                  category={'case_arm'}
                  title={this.formatTitle(element, "Clinical Trial")}
                  attribute={element}
                  unit={this.getTestUnit(element)}
                />
                <MolecularBoxplot
                  casecount={this.props.casecount}
                  tab={'lab_results'}
                  data={this.state.data}
                  category={'case_group'}
                  attribute={element}
                  unit={this.getTestUnit(element)}
                  title={this.formatTitle(element, "Observational Study")}
                />
                <MolecularLineChart
                  casecount={this.props.casecount}
                  data={this.state.data}
                  tab={'lab_results'}
                  category={'case_group'}
                  attribute={element}
                  unit={this.getTestUnit(element)}
                  title={this.formatTitle(element, "Observational Study")}
                />
              </Fragment>)
          })}
        </div>}
      </div>
    )
  }
}
