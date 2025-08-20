import React, { useEffect, useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot } from 'recharts';
import { askGuppyForRawData } from '@gen3/guppy/dist/components/Utils/queries';
import { guppyUrl } from '../../localconf';

const ARDaCSurvivalCurve = ({ fetchAndUpdateRawData, casecount, guppyConfig, filter }) => {
  const [survivalData, setSurvivalData] = useState({});
  const [outcomeType, setOutcomeType] = useState('death');
  const [groupingField, setGroupingField] = useState('none');
  const [patientCounts, setPatientCounts] = useState({});
  const [rawData, setRawData] = useState(null);
  const [dataQuality, setDataQuality] = useState({});
  const [censoredData, setCensoredData] = useState({});
  const [riskTableData, setRiskTableData] = useState({ riskTimePoints: [], riskTable: {} });

  const fetchingRef = useRef(false);

  const DATA_LIMIT = 5000;
  const COLORS = ['#2196F3', '#F44336', '#4CAF50', '#FF9800', '#9C27B0'];

  const outcomeTypes = [
    { value: 'death', label: 'Death (Overall Survival)' },
    { value: 'aki', label: 'AKI (Time to AKI)' }
  ];

  const getGroupingFields = () => {
    const baseFields = [{ value: 'none', label: 'NO GROUPING' }];
    const genderField = { value: 'gender', label: 'SEX' };

    const studyNameFilter = filter?.study_name;

    if (studyNameFilter) {
      let isClinical = false;
      let isObservational = false;

      if (Array.isArray(studyNameFilter)) {
        isClinical = studyNameFilter.includes('clinical_trial');
        isObservational = studyNameFilter.includes('observational');
      } else if (typeof studyNameFilter === 'object' && studyNameFilter.includes) {
        isClinical = studyNameFilter.includes('clinical_trial');
        isObservational = studyNameFilter.includes('observational');
      } else if (typeof studyNameFilter === 'string') {
        isClinical = studyNameFilter === 'clinical_trial';
        isObservational = studyNameFilter === 'observational';
      } else {
        const filterValues = Object.values(studyNameFilter);
        isClinical = filterValues.some(val =>
          Array.isArray(val) ? val.includes('clinical_trial') : val === 'clinical_trial'
        );
        isObservational = filterValues.some(val =>
          Array.isArray(val) ? val.includes('observational') : val === 'observational'
        );
      }

      if (isClinical && isObservational) {
        return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
      } else if (isClinical) {
        return [...baseFields, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
      } else if (isObservational) {
        return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, genderField];
      }
    }

    return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
  };

  const groupingFields = getGroupingFields();

  useEffect(() => {
    const availableValues = groupingFields.map(field => field.value);
    if (!availableValues.includes(groupingField)) {
      const defaultField = groupingFields.length > 1 ? groupingFields[1].value : 'none';
      setGroupingField(defaultField);
    }
  }, [filter, groupingFields, groupingField]);

  useEffect(() => {
    const fetchData = async () => {
      if (fetchingRef.current) return;

      if (!casecount || casecount <= 0) {
        setRawData(null);
        setSurvivalData({});
        setCensoredData({});
        setPatientCounts({});
        setDataQuality({});
        return;
      }

      try {
        fetchingRef.current = true;

        const caseRes = await fetchAndUpdateRawData({
          offset: 0,
          size: Math.min(DATA_LIMIT, casecount),
          sort: []
        });

        if (!caseRes?.data || caseRes.data.length === 0) {
          setRawData(null);
          setSurvivalData({});
          setCensoredData({});
          setPatientCounts({});
          setDataQuality({});
          return;
        }

        const processedData = {
          ...caseRes,
          data: caseRes.data
            .filter(record => record?.pat_id)
            .map(record => ({
              ...record,
              days_to_follow_up: (() => {
                if (record.visit_day_set && Array.isArray(record.visit_day_set) && record.visit_day_set.length > 0) {
                  const validDays = record.visit_day_set
                    .map(day => parseInt(day))
                    .filter(day => !isNaN(day) && day >= 0);
                  if (validDays.length > 0) {
                    return Math.max(...validDays);
                  }
                }
                return record.max_days_to_follow_up_test || record.visit_day || 0;
              })()
            }))
        };

        setRawData(processedData);

      } catch (error) {
        console.error('Error fetching ARDaC case data:', error);
        setRawData(null);
        setSurvivalData({});
        setCensoredData({});
        setPatientCounts({});
        setDataQuality({});
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchData();
  }, [casecount, fetchAndUpdateRawData, guppyConfig, groupingField, filter]);

  const checkDataQuality = (data, outcomeType) => {
    const quality = {
      totalPatients: data.length,
      includedPatients: 0,
      excludedPatients: 0,
      deathEvents: 0,
      akiEvents: 0,
      exclusionReasons: {
        deathNoValidTime: 0,
        akiNoValidTime: 0,
        akiUnknownStatus: 0,
        akiNoInvalidDeathTime: 0
      },
      warnings: []
    };

    data.forEach(patient => {
      let excluded = false;

      if (outcomeType === 'death') {
        if (patient.vital_status === 'dead') {
          if (!patient.days_to_death || patient.days_to_death === '' || parseInt(patient.days_to_death) <= 0) {
            quality.exclusionReasons.deathNoValidTime++;
            excluded = true;
          } else {
            quality.deathEvents++;
          }
        }
      } else if (outcomeType === 'aki') {
        if (patient.aki_status === 'Yes') {
          if (!patient.days_to_aki || patient.days_to_aki === '' || parseInt(patient.days_to_aki) <= 0) {
            quality.exclusionReasons.akiNoValidTime++;
            excluded = true;
          } else {
            quality.akiEvents++;
          }
        } else if (patient.aki_status === 'No') {
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            // Valid death time
          } else {
            if (!(patient.vital_status === 'alive' && (!patient.days_to_death || patient.days_to_death === ''))) {
              quality.exclusionReasons.akiNoInvalidDeathTime++;
              excluded = true;
            }
          }
        } else if (patient.aki_status === 'Unknown') {
          quality.exclusionReasons.akiUnknownStatus++;
          excluded = true;
        }
      }

      if (excluded) {
        quality.excludedPatients++;
      } else {
        quality.includedPatients++;
      }
    });

    if (quality.exclusionReasons.deathNoValidTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.deathNoValidTime} patients excluded: death status but non-positive/blank days_to_death`);
    }
    if (quality.exclusionReasons.akiNoValidTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiNoValidTime} patients excluded: AKI status 'Yes' but non-positive/blank days_to_aki`);
    }
    if (quality.exclusionReasons.akiNoInvalidDeathTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiNoInvalidDeathTime} patients excluded: AKI status 'No' with invalid death time`);
    }
    if (quality.exclusionReasons.akiUnknownStatus > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiUnknownStatus} patients excluded: AKI status 'Unknown'`);
    }

    return quality;
  };

  const prepareSurvivalData = (rawData, outcome, groupBy) => {
    const survivalPatients = [];

    const getGroupValue = (patient, groupBy) => {
      if (groupBy === 'none') return 'All';
      if (groupBy === 'actarm') {
        return patient.actarm || patient.treatment_arm || patient.act_arm || 'Unknown';
      }
      return patient[groupBy] || 'Unknown';
    };

    rawData.forEach(patient => {
      let time = null;
      let event = 0;
      let shouldExclude = false;
      let groupValue = getGroupValue(patient, groupBy);

      if (outcome === 'death') {
        if (patient.vital_status === 'dead') {
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            time = parseInt(patient.days_to_death);
            event = 1;
          } else {
            shouldExclude = true;
          }
        } else if (patient.vital_status === 'alive') {
          time = 180;
          event = 0;
        } else {
          shouldExclude = true;
        }
      } else if (outcome === 'aki') {
        if (patient.aki_status === 'Yes') {
          if (patient.days_to_aki && parseInt(patient.days_to_aki) > 0) {
            time = parseInt(patient.days_to_aki);
            event = 1;
          } else {
            shouldExclude = true;
          }
        } else if (patient.aki_status === 'No') {
          event = 0;
          
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            time = parseInt(patient.days_to_death);
          } else {
            if (patient.vital_status === 'alive' && (!patient.days_to_death || patient.days_to_death === '')) {
              time = 180;
            } else {
              shouldExclude = true;
            }
          }
        } else if (patient.aki_status === 'Unknown') {
          shouldExclude = true;
        } else {
          shouldExclude = true;
        }
      }

      if (!shouldExclude && time !== null && time >= 0) {
        survivalPatients.push({
          patientId: patient.pat_id,
          time: time,
          event: event,
          group: groupValue
        });
      }
    });

    return survivalPatients;
  };

  const calculateSurvivalData = (patients) => {
    if (!patients.length) return { survivalPoints: [], censoredPoints: [] };

    patients.sort((a, b) => a.time - b.time);

    const survivalPoints = [{ time: 0, survival: 1.0, atRisk: patients.length }];
    const censoredPoints = [];

    const timeGroups = {};
    patients.forEach(patient => {
      if (!timeGroups[patient.time]) {
        timeGroups[patient.time] = { events: 0, censored: 0 };
      }
      if (patient.event === 1) {
        timeGroups[patient.time].events++;
      } else {
        timeGroups[patient.time].censored++;
      }
    });

    let atRisk = patients.length;
    let survivalProb = 1.0;

    for (const time of Object.keys(timeGroups).sort((a, b) => a - b)) {
      const { events, censored } = timeGroups[time];

      if (atRisk <= 0) {
        break;
      }

      const survivalProbBeforeEvents = survivalProb;

      if (censored > 0 && parseInt(time) <= 180) {
        censoredPoints.push({
          time: parseInt(time),
          survival: survivalProbBeforeEvents
        });
      }

      if (events > 0) {
        survivalProb *= (1 - events / atRisk);
        
        survivalPoints.push({
          time: parseInt(time),
          survival: survivalProb,
          atRisk: atRisk,
          event: events,
          censored: censored
        });
      }

      atRisk -= (events + censored);
    }

    return { survivalPoints, censoredPoints };
  };

  useEffect(() => {
    if (!rawData?.data) return;

    const quality = checkDataQuality(rawData.data, outcomeType);
    setDataQuality(quality);

    const survivalPatients = prepareSurvivalData(rawData.data, outcomeType, groupingField);

    const groupedData = {};
    const groupedCensoredData = {};
    const counts = {};

    const groups = [...new Set(survivalPatients.map(p => p.group))];

    groups.forEach(group => {
      const groupPatients = survivalPatients.filter(p => p.group === group);
      counts[group] = groupPatients.length;

      if (groupPatients.length > 0) {
        const { survivalPoints, censoredPoints } = calculateSurvivalData(groupPatients);
        groupedData[group] = survivalPoints;
        groupedCensoredData[group] = censoredPoints;
      }
    });

    setSurvivalData(groupedData);
    setCensoredData(groupedCensoredData);
    setPatientCounts(counts);

    const calculateRiskTable = (survivalData) => {
      const riskTimePoints = [0, 30, 60, 90, 120, 150, 180];
      const riskTable = {};
      const cumulativeEventsTable = {};

      Object.entries(survivalData).forEach(([group, groupData]) => {
        riskTable[group] = {};
        cumulativeEventsTable[group] = {};
        
        riskTimePoints.forEach(timePoint => {
          let atRisk = 0;
          let cumulativeEvents = 0;
          
          if (timePoint === 0) {
            atRisk = groupData.length > 0 ? groupData[0].atRisk : 0;
            cumulativeEvents = 0;
          } else {
            // calculate cumulative events
            cumulativeEvents = groupData
              .filter(point => point.time <= timePoint)
              .reduce((sum, point) => sum + (point.event || 0), 0);
            
            // calculate at risk number
            for (let i = groupData.length - 1; i >= 0; i--) {
              if (groupData[i].time <= timePoint) {
                atRisk = groupData[i].atRisk - (groupData[i].event || 0) - (groupData[i].censored || 0);
                break;
              }
            }
            if (atRisk === 0 && groupData.length > 0) {
              atRisk = groupData[0].atRisk;
            }
          }
          
          riskTable[group][timePoint] = Math.max(0, atRisk);
          cumulativeEventsTable[group][timePoint] = cumulativeEvents;
        });
      });

      return { riskTimePoints, riskTable, cumulativeEventsTable };
    };

    const { riskTimePoints, riskTable, cumulativeEventsTable } = calculateRiskTable(groupedData);
    setRiskTableData({ riskTimePoints, riskTable, cumulativeEventsTable });

  }, [rawData, outcomeType, groupingField]);

  const chartData = (() => {
    const timePoints = new Set();
    
    Object.values(survivalData).forEach(groupData => {
      groupData.forEach(point => {
        if (point.time <= 180) {
          timePoints.add(point.time);
        }
      });
    });

    Object.values(censoredData).forEach(groupCensoredData => {
      groupCensoredData.forEach(point => {
        if (point.time <= 180) {
          timePoints.add(point.time);
        }
      });
    });

    timePoints.add(180);
    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    
    return sortedTimes
      .filter(time => time <= 180)
      .map(time => {
        const point = { time };
        
        Object.entries(survivalData).forEach(([group, groupData]) => {
          let survivalPoint = groupData.find(p => p.time === time);
          if (!survivalPoint) {
            for (let i = groupData.length - 1; i >= 0; i--) {
              if (groupData[i].time < time) {
                survivalPoint = groupData[i];
                break;
              }
            }
          }
          point[`survival_${group}`] = survivalPoint ? survivalPoint.survival : 1.0;
        });
        
        return point;
      });
  })();

  const censoredPoints = [];
  Object.entries(censoredData).forEach(([group, groupCensoredData], groupIndex) => {
    groupCensoredData.forEach(point => {
      if (point.time <= 180) {
        censoredPoints.push({
          time: point.time,
          survival: point.survival,
          group: group,
          color: COLORS[groupIndex % COLORS.length]
        });
      }
    });
  });

  const infoIconStyles = `
  .info-icon-container:hover .info-icon {
    background-color: #4B5563 !important;
  }
  .info-icon-container:hover .tooltip-content {
    opacity: 1 !important;
    visibility: visible !important;
  }
`;

  const CHART_CONFIG = {
    width: 800,
    height: 400,
    margin: { top: 20, right: 30, left: 70, bottom: 70 },
    dataWidth: 700,
    timePoints: [0, 30, 60, 90, 120, 150, 180]
  };

  const getXPosition = (timePoint) => {
    const positions = {
      0: 43.8125,
      30: 150.479,
      60: 257.146,
      90: 363.8125,
      120: 470.479,
      150: 577.146,
      180: 683.8125
    };
    
    const offset = -85;
    return (positions[timePoint] || 0) - offset;
  };

  return (
    <div className="w-full p-4">
      <style dangerouslySetInnerHTML={{ __html: infoIconStyles }} />
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">ARDaC Kaplan-Meier Survival Analysis</h3>
        <div className="flex gap-4">
          <div className="flex flex-col">
            <label style={{ fontSize: '0.875rem', fontWeight: '500', marginBottom: '8px', marginRight: '10px' }}>
              Outcome
            </label>
            <select
              value={outcomeType}
              onChange={(e) => setOutcomeType(e.target.value)}
              className="border rounded p-1 min-w-[200px]"
              disabled={fetchingRef.current}
            >
              {outcomeTypes.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label style={{ fontSize: '0.875rem', fontWeight: '500', marginBottom: '8px', marginRight: '10px' }}>
              Group by
            </label>
            <select
              value={groupingField}
              onChange={(e) => setGroupingField(e.target.value)}
              className="border rounded p-1 min-w-[150px]"
              disabled={fetchingRef.current}
            >
              {groupingFields.map(field => (
                <option key={field.value} value={field.value}>
                  {field.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {dataQuality.warnings && dataQuality.warnings.length > 0 && (
        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: '500', color: '#374151' }}>Data Quality:</span>
          <div style={{ position: 'relative' }} className="info-icon-container">
            <div 
              style={{ 
                width: '16px', 
                height: '16px', 
                backgroundColor: '#6B7280', 
                color: 'white', 
                borderRadius: '50%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                cursor: 'help',
                fontSize: '10px',
                fontWeight: 'bold'
              }}
              className="info-icon"
            >
              i
            </div>
            
            <div 
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: '8px',
                padding: '16px',
                backgroundColor: 'white',
                color: '#374151',
                border: '1px solid #D1D5DB',
                borderRadius: '8px',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                opacity: '0',
                visibility: 'hidden',
                transition: 'opacity 0.2s, visibility 0.2s',
                pointerEvents: 'none',
                zIndex: 1000,
                minWidth: '300px',
                maxWidth: '400px',
                whiteSpace: 'normal',
                wordWrap: 'break-word'
              }}
              className="tooltip-content"
            >
              <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '0.875rem', color: '#1F2937' }}>
                Data Quality Warnings:
              </div>
              <ul style={{ fontSize: '0.8rem', margin: 0, paddingLeft: '1.2rem', lineHeight: '1.5' }}>
                {dataQuality.warnings.map((warning, index) => (
                  <li key={index} style={{ 
                    marginBottom: '4px', 
                    color: '#6B7280',
                    wordWrap: 'break-word',
                    whiteSpace: 'normal'
                  }}>
                    • {warning}
                  </li>
                ))}
              </ul>
              <div style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: '6px solid white'
              }}></div>
            </div>
          </div>
        </div>
      )}

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#374151', margin: 0 }}>
            Kaplan-Meier Estimate of Survival Function
          </h4>
          <h7>With Number of Subjects at Risk and Cumulative Events</h7>
        </div>
        
        <div style={{ 
          position: 'relative', 
          width: `${CHART_CONFIG.width}px`, 
          height: `${CHART_CONFIG.height}px` 
        }}>
          {Object.keys(survivalData).length > 0 ? (
            <>
              <LineChart
                width={CHART_CONFIG.width}
                height={CHART_CONFIG.height}
                data={chartData}
                margin={CHART_CONFIG.margin}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={[0, 180]}
                  ticks={[0, 30, 60, 90, 120, 150, 180]}
                  label={{ value: 'Time (days)', position: 'bottom', offset: 40 }}
                />
                <YAxis
                  domain={[0, 1]}
                  label={{ 
                    value: 'Event-free Survival Probability', 
                    angle: -90, 
                    position: 'insideLeft',
                    textAnchor: 'middle',
                    offset: -10,
                    style: { textAnchor: 'middle' }
                  }}
                />
                <Tooltip
                  formatter={(value, name) => [
                    Number(value).toFixed(3),
                    `Survival (${name.split('_')[1]})`
                  ]}
                  labelFormatter={(label) => `Time: ${label} days`}
                />
                <Legend
                  formatter={(value) => value.split('_')[1]}
                  verticalAlign="bottom"
                  offset={20}
                />
                
                {Object.keys(survivalData).map((group, index) => (
                  <Line
                    key={group}
                    type="stepAfter"
                    dataKey={`survival_${group}`}
                    stroke={COLORS[index % COLORS.length]}
                    dot={false}
                    name={`survival_${group}`}
                  />
                ))}
                
                {censoredPoints.map((point, index) => (
                  <ReferenceDot
                    key={`censored_${point.group}_${point.time}_${index}`}
                    x={point.time}
                    y={point.survival}
                    r={0}
                    shape={(props) => {
                      const { cx, cy } = props;
                      return (
                        <g>
                          <line
                            x1={cx}
                            y1={cy - 6}
                            x2={cx}
                            y2={cy + 6}
                            stroke={point.color}
                            strokeWidth={2}
                          />
                          <line
                            x1={cx - 3}
                            y1={cy}
                            x2={cx + 3}
                            y2={cy}
                            stroke={point.color}
                            strokeWidth={2}
                          />
                        </g>
                      );
                    }}
                  />
                ))}
              </LineChart>
              
              <div style={{
                position: 'absolute',
                top: '-40px',
                right: '40px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid #E5E7EB',
                fontSize: '0.85rem',
                color: '#374151',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)'
              }}>
                <svg width="16" height="16" viewBox="0 0 16 16">
                  <line x1="8" y1="2" x2="8" y2="14" stroke="#666" strokeWidth="2"/>
                  <line x1="2" y1="8" x2="14" y2="8" stroke="#666" strokeWidth="2"/>
                </svg>
                <span>Censored</span>
              </div>
            </>
          
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                {fetchingRef.current ? (
                  <div className="text-blue-600">
                    <div className="animate-spin inline-block w-6 h-6 border-[3px] border-current border-t-transparent text-blue-600 rounded-full" role="status" aria-label="loading">
                      <span className="sr-only">Loading...</span>
                    </div>
                    <div className="mt-2">Loading ARDaC survival data...</div>
                  </div>
                ) : (
                  <div className="text-gray-500">
                    <div className="text-lg mb-2">📊</div>
                    <div className="font-medium">No survival data available</div>
                    <div className="text-sm mt-1">Try adjusting the filter criteria to include more patients</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {Object.keys(survivalData).length > 0 && (
          <div style={{ 
            marginTop: '20px', 
            marginBottom: '40px', 
            width: `${CHART_CONFIG.width}px`,
            position: 'relative'
          }}>

            {Object.entries(riskTableData.riskTable).map(([group, groupRiskData], groupIndex) => (
              <div key={group} style={{ marginBottom: '8px' }}>
                {/* At Risk row */}
                <div style={{ 
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '2px',
                  height: '20px'
                }}>
                  <div style={{ 
                    width: '200px',                              
                    fontSize: '0.75rem',
                    fontWeight: '500',
                    color: COLORS[groupIndex % COLORS.length],
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                    overflow: 'visible',                         
                    position: 'relative',
                    left: '-100px'
                  }}>
                    {group} (At Risk)
                  </div>
                  
                  {CHART_CONFIG.timePoints.map(timePoint => (
                    <div 
                      key={timePoint} 
                      style={{ 
                        position: 'absolute',
                        left: `${getXPosition(timePoint)}px`,
                        transform: 'translateX(-50%)',
                        fontSize: '0.75rem',
                        color: '#374151',
                        textAlign: 'center'
                      }}
                    >
                      {groupRiskData[timePoint] || 0}
                    </div>
                  ))}
                </div>

                {/* Cumulative Events row */}
                <div style={{ 
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '4px',
                  height: '20px'
                }}>
                  <div style={{ 
                    width: '200px',                              
                    fontSize: '0.75rem',
                    fontWeight: '400',
                    color: '#6B7280',
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                    overflow: 'visible',                         
                    position: 'relative',
                    left: '-100px'
                  }}>
                    (Events)
                  </div>
                  
                  {CHART_CONFIG.timePoints.map(timePoint => (
                    <div 
                      key={timePoint} 
                      style={{ 
                        position: 'absolute',
                        left: `${getXPosition(timePoint)}px`,
                        transform: 'translateX(-50%)',
                        fontSize: '0.75rem',
                        color: '#6B7280',
                        textAlign: 'center'
                      }}
                    >
                      {riskTableData.cumulativeEventsTable?.[group]?.[timePoint] || 0}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ARDaCSurvivalCurve;