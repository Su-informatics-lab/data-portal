import React from 'react';
import SummaryBoxplotChart from './SummaryBoxPlotChart';
import StackedLineChart from './StackedLineChart';

export class MolecularTestTab extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        labTestTypes : []
      };
    }
    _isMounted = false;


    componentDidMount(){
      // if(this.props.casecount>=0 && this.props.casecount<=10000){
      //   console.log(this.props.casecount)
      //   this.fetchData(this.props.casecount)
      // }
    }

    componentWillReceiveProps(nextProps){
        if(this.props.casecount !== nextProps.casecount){
          if(nextProps.casecount>=0 && nextProps.casecount<=10000){
            this.fetchData(nextProps.casecount)
          }
        }
      }

    getLabTestType(data){
        const unique = [...new Set(data.map(item => item['laboratory_test']))]; 
        console.log(unique)
        this.setState({
            labTestTypes: unique
        })
    }

    fetchData(casecount){
        const size = casecount
        const offset = 0
        const sort = []
        this.props.fetchAndUpdateRawData({
          offset, size, sort
        }).then((res) => {
            this.getLabTestType(res.data)
        });
      };

    render() {
        return (
        <div>
          {this.props.casecount<=10000 && 
            <div className="summary-chart-group" style={{height:'fit-content', minHeight:400}}>
              {this.state.labTestTypes.length>0 && this.state.labTestTypes.map(element => {
                return (
                <>
                <SummaryBoxplotChart
                  casecount={this.props.casecount}
                  tab={'lab_results'}
                  fetchAndUpdateRawData={this.props.fetchAndUpdateRawData}
                  category={'case_arm'}
                  attribute={element}
                  title={element+" clinicial"}
                />
                <StackedLineChart
                  casecount={this.props.casecount}
                  fetchAndUpdateRawData={this.props.fetchAndUpdateRawData}  
                  tab={'lab_results'}
                  category={'case_arm'}
                  title={element+" clinicial"}
                  attribute={element}
                />
                <SummaryBoxplotChart
                  casecount={this.props.casecount}
                  tab={'lab_results'}
                  fetchAndUpdateRawData={this.props.fetchAndUpdateRawData}
                  category={'case_group'}
                  attribute={element}
                  title={element+" Obs"}
                />
                <StackedLineChart
                  casecount={this.props.casecount}
                  fetchAndUpdateRawData={this.props.fetchAndUpdateRawData}  
                  tab={'lab_results'}
                  category={'case_group'}
                  attribute={element}
                  title={element+" Obs"}
                />
              </>)
              })}

              </div> }
          </div>
        )
    }
}
