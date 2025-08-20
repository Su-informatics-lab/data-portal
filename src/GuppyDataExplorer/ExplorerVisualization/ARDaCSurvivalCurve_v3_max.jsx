import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { askGuppyForRawData } from '@gen3/guppy/dist/components/Utils/queries';
import { guppyUrl } from '../../localconf';

// Constants
const DATA_LIMIT = 5000;
const COLORS = ['#2196F3', '#F44336', '#4CAF50', '#FF9800', '#9C27B0'];
const OUTCOME_TYPES = [
  { value: 'death', label: 'Death (Overall Survival)' },
  { value: 'aki', label: 'AKI (Time to AKI)' }
];

// Utility functions
const parseFilterValue = (filterValue) => {
  if (Array.isArray(filterValue)) {
    return filterValue;
  }
  if (typeof filterValue === 'object' && filterValue?.includes) {
    return filterValue;
  }
  if (typeof filterValue === 'string') {
    return [filterValue];
  }
  if (typeof filterValue === 'object') {
    return Object.values(filterValue).flat();
  }
  return [];
};

const validatePatientData = (patient) => {
  return patient && 
         patient.pat_id && 
         typeof patient.pat_id === 'string' && 
         patient.pat_id.trim() !== '';
};

const calculateFollowUpDays = (patient) => {
  // First choice: use max value from visit_day_set
  if (patient.visit_day_set && Array.isArray(patient.visit_day_set) && patient.visit_day_set.length > 0) {
    const validDays = patient.visit_day_set
      .map(day => parseInt(day, 10))
      .filter(day => !isNaN(day) && day >= 0);
    if (validDays.length > 0) {
      return Math.max(...validDays);
    }
  }

  // Second choice: use max_days_to_follow_up_test/visit_day/0
  return patient.max_days_to_follow_up_test || patient.visit_day || 0;
};

const ARDaCSurvivalCurve = ({ fetchAndUpdateRawData, casecount, guppyConfig, filter }) => {
  const [survivalData, setSurvivalData] = useState({});
  const [outcomeType, setOutcomeType] = useState('death');
  const [groupingField, setGroupingField] = useState('none');
  const [patientCounts, setPatientCounts] = useState({});
  const [rawData, setRawData] = useState(null);
  const [dataQuality, setDataQuality] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchingRef = useRef(false);

  // Memoized grouping fields calculation
  const groupingFields = useMemo(() => {
    const baseFields = [{ value: 'none', label: 'NO GROUPING' }];
    const genderField = { value: 'gender', label: 'GENDER' };

    const studyNameFilter = filter?.study_name;
    if (!studyNameFilter) {
      return [...baseFields, { value: 'cohort', label: 'COHORT' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
    }

    const filterValues = parseFilterValue(studyNameFilter);
    const isClinical = filterValues.includes('clinical_trial');
    const isObservational = filterValues.includes('observational');

    if (isClinical && isObservational) {
      return [...baseFields, { value: 'cohort', label: 'COHORT' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
    } else if (isClinical) {
      return [...baseFields, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
    } else if (isObservational) {
      return [...baseFields, { value: 'cohort', label: 'COHORT' }, genderField];
    }

    return [...baseFields, { value: 'cohort', label: 'COHORT' }, { value: 'actarm', label: 'TREATMENT ARM' }, genderField];
  }, [filter?.study_name]);

  // When filter changes, check and adjust current selected grouping field
  useEffect(() => {
    const availableValues = groupingFields.map(field => field.value);
    if (!availableValues.includes(groupingField)) {
      const defaultField = groupingFields.length > 1 ? groupingFields[1].value : 'none';
      setGroupingField(defaultField);
    }
  }, [groupingFields, groupingField]);

  // Data quality check function
  const checkDataQuality = useCallback((data) => {
    const quality = {
      totalPatients: data.length,
      deathEvents: 0,
      akiEvents: 0,
      missingDeathTime: 0,
      missingAkiTime: 0,
      negativeDays: 0,
      warnings: []
    };

    data.forEach(patient => {
      // Check death data
      if (patient.vital_status === 'dead') {
        quality.deathEvents++;
        if (!patient.days_to_death || patient.days_to_death === '' || parseInt(patient.days_to_death, 10) < 0) {
          quality.missingDeathTime++;
        }
      }

      // Check AKI data
      if (patient.aki_status === 'Yes') {
        quality.akiEvents++;
        if (!patient.days_to_aki || patient.days_to_aki === '' || parseInt(patient.days_to_aki, 10) < 0) {
          quality.missingAkiTime++;
        }
      }

      // Check negative days
      const deathDays = parseInt(patient.days_to_death, 10);
      const akiDays = parseInt(patient.days_to_aki, 10);
      if ((patient.days_to_death && deathDays < 0) || (patient.days_to_aki && akiDays < 0)) {
        quality.negativeDays++;
      }
    });

    // Generate warnings
    if (quality.missingDeathTime > 0) {
      quality.warnings.push(`${quality.missingDeathTime} patients with death status 'dead' but missing/invalid death time`);
    }
    if (quality.missingAkiTime > 0) {
      quality.warnings.push(`${quality.missingAkiTime} patients with AKI status 'Yes' but missing/invalid AKI time`);
    }
    if (quality.negativeDays > 0) {
      quality.warnings.push(`${quality.negativeDays} patients with negative time values`);
    }

    return quality;
  }, []);

  // Get group value for a patient
  const getGroupValue = useCallback((patient, groupBy) => {
    if (groupBy === 'none') return 'All';
    
    if (groupBy === 'actarm') {
      return patient.actarm || patient.treatment_arm || patient.act_arm || 'Unknown';
    }
    
    return patient[groupBy] || 'Unknown';
  }, []);

  // Prepare survival data
  const prepareSurvivalData = useCallback((rawDataArray, outcome, groupBy) => {
    const survivalPatients = [];
    const debugInfo = {
      totalPatients: rawDataArray.length,
      excludedPatients: 0,
      negativeTimes: 0,
      missingTimes: 0,
      timeRange: { min: Infinity, max: -Infinity }
    };

    rawDataArray.forEach(patient => {
      let time = null;
      let event = 0;
      const groupValue = getGroupValue(patient, groupBy);

      if (outcome === 'death') {
        if (patient.vital_status === 'dead') {
          const deathDays = parseInt(patient.days_to_death, 10);
          if (patient.days_to_death && deathDays >= 0) {
            time = deathDays;
            event = 1;
          } else {
            debugInfo.negativeTimes++;
            time = patient.days_to_follow_up;
            event = 1;
          }
        } else {
          time = patient.days_to_follow_up;
          event = 0;
        }
      } else if (outcome === 'aki') {
        const deathTime = patient.days_to_death && parseInt(patient.days_to_death, 10) >= 0
          ? parseInt(patient.days_to_death, 10)
          : parseInt(patient.days_to_follow_up, 10);
        
        const akiTime = patient.days_to_aki && parseInt(patient.days_to_aki, 10) >= 0
          ? parseInt(patient.days_to_aki, 10)
          : parseInt(patient.days_to_follow_up, 10);

        if (patient.vital_status === 'dead' && patient.aki_status === 'Yes') {
          // Both events - use the earlier one
          if (!isNaN(akiTime) && akiTime <= deathTime) {
            time = akiTime;
            event = 1;
          } else {
            time = deathTime;
            event = 0; // censored by death
          }
        } else if (patient.vital_status === 'dead') {
          time = deathTime;
          event = 0;
        } else if (patient.aki_status === 'Yes') {
          if (patient.days_to_aki && parseInt(patient.days_to_aki, 10) >= 0) {
            time = parseInt(patient.days_to_aki, 10);
            event = 1;
          } else {
            debugInfo.negativeTimes++;
            time = patient.days_to_follow_up;
            event = 1;
          }
        } else {
          time = patient.days_to_follow_up;
          event = 0;
        }
      }

      if (time !== null && time >= 0) {
        survivalPatients.push({
          patientId: patient.pat_id,
          time: time,
          event: event,
          group: groupValue
        });

        debugInfo.timeRange.min = Math.min(debugInfo.timeRange.min, time);
        debugInfo.timeRange.max = Math.max(debugInfo.timeRange.max, time);
      } else {
        debugInfo.excludedPatients++;
      }
    });

    return survivalPatients;
  }, [getGroupValue]);

  // Kaplan-Meier calculation
  const calculateSurvivalData = useCallback((patients) => {
    if (!patients.length) return [];

    // Sort by time
    patients.sort((a, b) => a.time - b.time);

    const survivalPoints = [{ time: 0, survival: 1.0, atRisk: patients.length }];

    // Group by time
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

    // Calculate survival probability
    for (const time of Object.keys(timeGroups).sort((a, b) => Number(a) - Number(b))) {
      const { events, censored } = timeGroups[time];

      if (atRisk <= 0) break;

      if (events > 0) {
        survivalProb *= (1 - events / atRisk);
        survivalPoints.push({
          time: parseInt(time, 10),
          survival: survivalProb,
          atRisk: atRisk,
          event: events,
          censored: censored
        });
      }

      atRisk -= (events + censored);
    }

    return survivalPoints;
  }, []);

  // Data fetching effect
  useEffect(() => {
    const fetchData = async () => {
      if (fetchingRef.current) return;

      // If no case count, clear data and return
      if (!casecount || casecount <= 0) {
        setRawData(null);
        setSurvivalData({});
        setPatientCounts({});
        setDataQuality({});
        setError(null);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);
        fetchingRef.current = true;

        // Get case data
        const caseRes = await fetchAndUpdateRawData({
          offset: 0,
          size: Math.min(DATA_LIMIT, casecount),
          sort: []
        });

        // Handle no data
        if (!caseRes?.data || caseRes.data.length === 0) {
          setRawData(null);
          setSurvivalData({});
          setPatientCounts({});
          setDataQuality({});
          return;
        }

        // Process data: filter valid patients and calculate follow-up days
        const processedData = {
          ...caseRes,
          data: caseRes.data
            .filter(validatePatientData)
            .map(record => ({
              ...record,
              days_to_follow_up: calculateFollowUpDays(record)
            }))
        };

        setRawData(processedData);

      } catch (error) {
        console.error('Error fetching ARDaC case data:', error);
        setError('Failed to fetch survival data. Please try again.');
        setRawData(null);
        setSurvivalData({});
        setPatientCounts({});
        setDataQuality({});
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    };

    fetchData();
  }, [casecount, fetchAndUpdateRawData, guppyConfig, filter]);

  // Main data processing effect
  useEffect(() => {
    if (!rawData?.data) return;

    try {
      // Check data quality
      const quality = checkDataQuality(rawData.data);
      setDataQuality(quality);

      // Prepare survival data
      const survivalPatients = prepareSurvivalData(rawData.data, outcomeType, groupingField);

      // Group by group
      const groupedData = {};
      const counts = {};
      const groups = [...new Set(survivalPatients.map(p => p.group))];

      groups.forEach(group => {
        const groupPatients = survivalPatients.filter(p => p.group === group);
        counts[group] = groupPatients.length;

        if (groupPatients.length > 0) {
          groupedData[group] = calculateSurvivalData(groupPatients);
        }
      });

      setSurvivalData(groupedData);
      setPatientCounts(counts);
    } catch (error) {
      console.error('Error processing survival data:', error);
      setError('Error processing survival data. Please check your data format.');
    }
  }, [rawData, outcomeType, groupingField, checkDataQuality, prepareSurvivalData, calculateSurvivalData]);

  // Chart data calculation
  const chartData = useMemo(() => {
    const timePoints = new Set();
    Object.values(survivalData).forEach(groupData => {
      groupData.forEach(point => timePoints.add(point.time));
    });

    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    return sortedTimes.map(time => {
      const point = { time };
      Object.entries(survivalData).forEach(([group, groupData]) => {
        let survivalPoint = groupData.find(p => p.time === time);
        if (!survivalPoint) {
          // Find the most recent survival probability
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
  }, [survivalData]);

  return (
    <div className="w-full p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">ARDaC Kaplan-Meier Survival Analysis</h3>
        <div className="flex gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Outcome</label>
            <select
              value={outcomeType}
              onChange={(e) => setOutcomeType(e.target.value)}
              className="border rounded p-1 min-w-[200px]"
              disabled={isLoading}
            >
              {OUTCOME_TYPES.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Group By</label>
            <select
              value={groupingField}
              onChange={(e) => setGroupingField(e.target.value)}
              className="border rounded p-1 min-w-[150px]"
              disabled={isLoading}
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

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded">
          <div className="font-medium text-red-800 mb-1">Error:</div>
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      {/* Data quality report */}
      {dataQuality.warnings && dataQuality.warnings.length > 0 && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
          <div className="font-medium text-yellow-800 mb-1">Data Quality Warnings:</div>
          <ul className="text-sm text-yellow-700">
            {dataQuality.warnings.map((warning, index) => (
              <li key={index}>• {warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Patient count */}
      {Object.keys(patientCounts).length > 0 ? (
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
              <div>Total events: {outcomeType === 'death' ? dataQuality.deathEvents : dataQuality.akiEvents} / {dataQuality.totalPatients}</div>
              <div>Using max_days_to_follow_up_test for follow-up time</div>
            </div>
          )}
        </div>
      ) : (
        !isLoading && !error && (
          <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded">
            <div className="text-gray-600 text-center">
              No patients match the current filter criteria for survival analysis
            </div>
          </div>
        )
      )}

      {/* Survival curve */}
      <div className="w-full" style={{ minHeight: '400px' }}>
        {Object.keys(survivalData).length > 0 ? (
          <div className="w-full overflow-x-auto">
            <LineChart
              width={Math.max(800, typeof window !== 'undefined' ? window.innerWidth * 0.8 : 800)}
              height={400}
              data={chartData}
              margin={{ top: 20, right: 30, left: 50, bottom: 70 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                type="number"
                label={{ value: 'Time (days)', position: 'bottom', offset: -5 }}
              />
              <YAxis
                domain={[0, 1]}
                label={{ value: 'Survival Probability', angle: -90, position: 'insideLeft' }}
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
                height={36}
              />
              {Object.keys(survivalData).map((group, index) => (
                <Line
                  key={group}
                  type="stepAfter"
                  dataKey={`survival_${group}`}
                  stroke={COLORS[index % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                  name={`survival_${group}`}
                />
              ))}
            </LineChart>
          </div>
        ) : (
          <div className="h-[400px] flex items-center justify-center">
            <div className="text-center">
              {isLoading ? (
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
  );
};

export default ARDaCSurvivalCurve;