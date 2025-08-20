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

  const fetchingRef = useRef(false);

  const DATA_LIMIT = 5000;
  const COLORS = ['#2196F3', '#F44336', '#4CAF50', '#FF9800', '#9C27B0'];

  // outcome type
  const outcomeTypes = [
    { value: 'death', label: 'Death (Overall Survival)' },
    { value: 'aki', label: 'AKI (Time to AKI)' }
  ];

  // get grouping fields based on current filter
  const getGroupingFields = () => {
    const baseFields = [{ value: 'none', label: 'NO GROUPING' }];
    const genderField = { value: 'gender', label: 'SEX' };

    const studyNameFilter = filter?.study_name;

    if (studyNameFilter) {
      // determine which study types are selected
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

      // return appropriate options based on selection
      if (isClinical && isObservational) {
        // both selected: show all options
        return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
      } else if (isClinical) {
        // only clinical: show treatment arm
        return [...baseFields, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
      } else if (isObservational) {
        // only observational: show cohort
        return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, genderField];
      }
    }

    // default: show all options
    return [...baseFields, { value: 'cohort', label: 'OBS GROUP' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
  };

  const groupingFields = getGroupingFields();

  // when filter changes, check and adjust current selected grouping field
  useEffect(() => {
    const availableValues = groupingFields.map(field => field.value);
    if (!availableValues.includes(groupingField)) {
      // if current selected grouping field is not in available options, reset to default
      const defaultField = groupingFields.length > 1 ? groupingFields[1].value : 'none';
      setGroupingField(defaultField);
    }
  }, [filter, groupingFields, groupingField]);

  useEffect(() => {
    const fetchData = async () => {
      if (fetchingRef.current) return;

              // if no case count, clear data and return
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

        // get case data
        const caseRes = await fetchAndUpdateRawData({
          offset: 0,
          size: Math.min(DATA_LIMIT, casecount),
          sort: []
        });

        // handle no data
        if (!caseRes?.data || caseRes.data.length === 0) {
          setRawData(null);
          setSurvivalData({});
          setCensoredData({});
          setPatientCounts({});
          setDataQuality({});
          return;
        }

        // processedData: fnmax is not working in ETL
        const processedData = {
          ...caseRes,
          data: caseRes.data
            .filter(record => record?.pat_id)
            .map(record => ({
              ...record,
              // use max value from visit_day_set, then fallback to other fields
              days_to_follow_up: (() => {
                // first choice: use max value from visit_day_set
                if (record.visit_day_set && Array.isArray(record.visit_day_set) && record.visit_day_set.length > 0) {
                  const validDays = record.visit_day_set
                    .map(day => parseInt(day))
                    .filter(day => !isNaN(day) && day >= 0);
                  if (validDays.length > 0) {
                    return Math.max(...validDays);
                  }
                }

                // second choice: use max_days_to_follow_up_test/visit_day/0
                return record.max_days_to_follow_up_test || record.visit_day || 0;
              })()
            }))
        };

        setRawData(processedData);

      } catch (error) {
        console.error('Error fetching ARDaC case data:', error);
        // when error occurs, clear data
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

  // data quality check
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
        akiNoInvalidDeathTime: 0  // 新增：AKI=No但死亡时间无效的患者
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
          // 新增：检查AKI=No患者的排除情况
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            // days_to_death有效，不排除
            console.log('AKI=No patient included:', patient.pat_id, 'days_to_death:', patient.days_to_death, 'vital_status:', patient.vital_status);
          } else {
            // days_to_death无效，检查是否需要排除
            if (!(patient.vital_status === 'alive' && (!patient.days_to_death || patient.days_to_death === ''))) {
              quality.exclusionReasons.akiNoInvalidDeathTime++;
              excluded = true;
              console.log('AKI=No patient excluded:', patient.pat_id, 'days_to_death:', patient.days_to_death, 'vital_status:', patient.vital_status);
            } else {
              console.log('AKI=No patient included (alive with blank death time):', patient.pat_id, 'vital_status:', patient.vital_status);
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

    // generate warnings
    if (quality.exclusionReasons.deathNoValidTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.deathNoValidTime} patients excluded: death status but non-positive/blank days_to_death`);
    }
    if (quality.exclusionReasons.akiNoValidTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiNoValidTime} patients excluded: AKI status 'Yes' but non-positive/blank days_to_aki`);
    }
    if (quality.exclusionReasons.akiNoInvalidDeathTime > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiNoInvalidDeathTime} patients excluded: AKI status 'No' with invalid death time (alive with days_to_death ≤ 0, or dead with non-positive/blank days_to_death)`);
    }
    if (quality.exclusionReasons.akiUnknownStatus > 0) {
      quality.warnings.push(`${quality.exclusionReasons.akiUnknownStatus} patients excluded: AKI status 'Unknown'`);
    }

    console.log('Quality check results:', quality.exclusionReasons);
    return quality;
  };

  // prepare survival data
  const prepareSurvivalData = (rawData, outcome, groupBy) => {
    const survivalPatients = [];
    const debugInfo = {
      totalPatients: rawData.length,
      excludedPatients: 0,
      includedPatients: 0
    };

    // field mapping: handle possible field name differences
    const getGroupValue = (patient, groupBy) => {
      if (groupBy === 'none') return 'All';

      // if actarm, try multiple possible field names
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
          // 死亡患者：需要有效的 days_to_death > 0
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            time = parseInt(patient.days_to_death);
            event = 1;
          } else {
            // 死亡但没有有效死亡时间，排除
            shouldExclude = true;
          }
        } else if (patient.vital_status === 'alive') {
          // 存活患者：event=1, time=180
          time = 180;
          event = 0;
        } else {
          // 其他vital_status，排除
          shouldExclude = true;
        }
      } else if (outcome === 'aki') {
        if (patient.aki_status === 'Yes') {
          // AKI为Yes：需要有效的 days_to_aki > 0
          if (patient.days_to_aki && parseInt(patient.days_to_aki) > 0) {
            time = parseInt(patient.days_to_aki);
            event = 1;
          } else {
            // AKI为Yes但没有有效AKI时间，排除
            shouldExclude = true;
          }
        } else if (patient.aki_status === 'No') {
          // AKI为No：删失事件，event=0
          event = 0;
          
          if (patient.days_to_death && parseInt(patient.days_to_death) > 0) {
            // days_to_death > 0：使用days_to_death
            time = parseInt(patient.days_to_death);
          } else {
            // days_to_death <= 0 或者 blank：检查vital_status
            if (patient.vital_status === 'alive' && (!patient.days_to_death || patient.days_to_death === '')) {
              // vital_status=alive 且 days_to_death是blank：time=180
              time = 180;
            } else {
              // 其余情况：排除
              // 包括：
              // - vital_status=alive 但 days_to_death <= 0
              // - vital_status=dead 但 days_to_death <= 0 或 blank
              // - vital_status 为其他值
              shouldExclude = true;
            }
          }
        } else if (patient.aki_status === 'Unknown') {
          // AKI状态未知，排除
          shouldExclude = true;
        } else {
          // 其他aki_status，排除
          shouldExclude = true;
        }
      }

      if (shouldExclude) {
        debugInfo.excludedPatients++;
      } else if (time !== null && time >= 0) {
        survivalPatients.push({
          patientId: patient.pat_id,
          time: time,
          event: event,
          group: groupValue
        });
        debugInfo.includedPatients++;
      }
    });

    return survivalPatients;
  };

  // Kaplan-Meier calculation
  const calculateSurvivalData = (patients) => {
    if (!patients.length) return { survivalPoints: [], censoredPoints: [] };

    // sort by time
    patients.sort((a, b) => a.time - b.time);

    console.log('Sorted patients for KM calculation:', patients.slice(0, 10)); // 查看前10个患者

    const survivalPoints = [{ time: 0, survival: 1.0, atRisk: patients.length }];
    const censoredPoints = [];

    // group by time
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

    console.log('Time groups:', timeGroups); // 查看时间分组

    let atRisk = patients.length;
    let survivalProb = 1.0;

    // calculate survival probability and collect censored points
    for (const time of Object.keys(timeGroups).sort((a, b) => a - b)) {
      const { events, censored } = timeGroups[time];

      if (atRisk <= 0) {
        break;
      }

      // 对于同一时间点：删失的患者标记在事件处理之前的生存概率水平上
      // 因为删失的患者在该时间点还在风险中，只是之后不再观察
      const survivalProbBeforeEvents = survivalProb;

      // 先收集删失事件点（使用事件处理前的生存概率）
      if (censored > 0 && parseInt(time) <= 180) {
        censoredPoints.push({
          time: parseInt(time),
          survival: survivalProbBeforeEvents
        });
        console.log(`Censored at time ${time}: survival=${survivalProbBeforeEvents}, censored=${censored}`);
      }

      // 然后处理事件，更新生存概率
      if (events > 0) {
        survivalProb *= (1 - events / atRisk);
        
        survivalPoints.push({
          time: parseInt(time),
          survival: survivalProb,
          atRisk: atRisk,
          event: events,
          censored: censored
        });
        
        console.log(`Time ${time}: events=${events}, atRisk=${atRisk}, oldSurvival=${survivalProbBeforeEvents}, newSurvival=${survivalProb}`);
      }

      // 最后从风险人数中减去事件和删失的人数
      // 删失的影响会在下一个事件时间点体现（风险人数减少）
      atRisk -= (events + censored);
    }

    return { survivalPoints, censoredPoints };
  };

  // main data processing effect
  useEffect(() => {
    if (!rawData?.data) return;

    // check data quality - 传入当前的outcome类型
    const quality = checkDataQuality(rawData.data, outcomeType);
    setDataQuality(quality);

    // prepare survival data
    const survivalPatients = prepareSurvivalData(rawData.data, outcomeType, groupingField);

    // group by group
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

  }, [rawData, outcomeType, groupingField]);

  // plot data - 截断在180天
  const chartData = (() => {
    const timePoints = new Set();
    
    // 收集生存数据的时间点
    Object.values(survivalData).forEach(groupData => {
      groupData.forEach(point => {
        if (point.time <= 180) {
          timePoints.add(point.time);
        }
      });
    });

    // 收集删失数据的时间点
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
        
        // 添加生存数据
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

  // 生成删失点数据
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

      {/* data quality report - 只显示图标，hover显示详情 */}
      {dataQuality.warnings && dataQuality.warnings.length > 0 && (
        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: '500', color: '#374151' }}>Data Quality:</span>
          <div style={{ position: 'relative' }} className="info-icon-container">
            {/* 小的信息图标 */}
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
            
            {/* 白色底的宽tooltip - 修正换行问题 */}
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
                whiteSpace: 'normal',  // 确保文本能正常换行
                wordWrap: 'break-word'  // 长单词也能换行
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
                    wordWrap: 'break-word',  // 确保每个列表项也能换行
                    whiteSpace: 'normal'
                  }}>
                    • {warning}
                  </li>
                ))}
              </ul>
              {/* 小箭头 - 白色底 */}
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

      {/* patient count - 去掉下方的警告文本显示 */}
      {/* {Object.keys(patientCounts).length > 0 ? (
        <div className="mb-4 p-2 bg-blue-50 border border-blue-200 rounded">
          <div className="font-medium mb-1">Patients per group:</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {Object.entries(patientCounts).map(([group, count]) => (
              <div key={group} className="text-sm">
                {group}: {count} patients
              </div>
            ))}
          </div>
          {dataQuality.totalPatients && (
            <div className="mt-2 text-sm text-blue-600 space-y-1">
              <div>Total patients: {dataQuality.totalPatients}</div>
              <div>Included: {dataQuality.includedPatients} | Excluded: {dataQuality.excludedPatients}</div>
              <div>Events: {outcomeType === 'death' ? dataQuality.deathEvents : dataQuality.akiEvents}</div>
            </div>
          )}
        </div>
      ) : (
        !fetchingRef.current && (
          <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded">
            <div className="text-gray-600 text-center">
              No patients match the current filter criteria for survival analysis
            </div>
          </div>
        )
      )} */}

      {/* survival curve */}
      <div className="w-full">
        {/* 图表标题 */}
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#374151', margin: 0 }}>
            Kaplan-Meier Survival Curve
          </h4>
        </div>
        
        <div className="w-full h-[400px]" style={{ position: 'relative' }}>
          {Object.keys(survivalData).length > 0 ? (
            <>
              <LineChart
                width={800}
                height={400}
                data={chartData}
                margin={{ top: 20, right: 30, left: 70, bottom: 70 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={[0, 180]}
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
                
                {/* 生存曲线 */}
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
                
                {/* 删失标记 - 使用ReferenceDot */}
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
                          {/* 垂直线 */}
                          <line
                            x1={cx}
                            y1={cy - 6}
                            x2={cx}
                            y2={cy + 6}
                            stroke={point.color}
                            strokeWidth={2}
                          />
                          {/* 水平线 */}
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
      </div>
    </div>
  );
};

export default ARDaCSurvivalCurve;