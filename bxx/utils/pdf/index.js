/** PDF 课表导入：解析、错误类型与课程对象映射的统一出口。 */
const { parsePdfTimetable } = require('./parser.js');
const { toCourses, maxWeekOf, COURSE_FIELDS } = require('./courses.js');
const { PdfImportError } = require('./errors.js');

module.exports = { parsePdfTimetable, toCourses, maxWeekOf, COURSE_FIELDS, PdfImportError };
